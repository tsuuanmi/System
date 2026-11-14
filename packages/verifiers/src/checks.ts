/**
 * `code.required-checks`: run a repository's required check commands on a
 * fresh worktree of the exact commit under judgment.
 *
 * Criteria are pinned at admission from `.system/checks.yaml` **at the task's
 * base commit**, so a Worker cannot weaken them by editing that file. Each
 * check runs `sh -c <run>` in the worktree with a minimal environment and its
 * own timeout; its exit, duration and output tails are one evidence Artifact.
 * The change is what differs from the task's base (and from the subject's parent); a check that failed in an earlier verdict of the same step in the Work runs again.
 * Verdict: `pass` when every check exits 0 and leaves no Xvfb or Chrome running (it is named and killed), `fail` when any does not (a
 * timeout is a failure), `inconclusive` when every failing check fails on the base commit too (run again by name, up to the
 * last failed check; not for a subject that is the base itself) and still does when the failing checks are run once more, on the change and then on the base
 * (sc-13: load, not the change, often fails a check; the re-run is one, never more, and the evidence holds all runs in order: change, base, change, base). If the change then passes, the
 * verdict follows it (`pass`); if the base now passes and the change still fails, the change's failure counts (`fail`); `error` when the checks could not be run at all.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, matchesGlob } from 'node:path'
import type { Spawner } from '@system/agents'
import type { Artifacts } from '@system/artifacts'
import { TASK_KIND, addWorktree, git, removeWorktree, type GitTreeContent, type Task, type VerifierPort, type VerifyResult } from '@system/work'
import { parse } from 'yaml'
import { firstFailure, interrupted, nodeBin } from './reasons.ts'
import { z } from 'zod'

export const CHECKS_FILE = '.system/checks.yaml'
/** The criteria names, pinned in the `checks@1` Artifact, and what each verdict means; any other name refuses admission. */
export const REPO_CHECKS = 'repo-checks-v1'
export const CRITERIA_NAMES = [REPO_CHECKS] as const
const TAIL = 16 * 1024

export const CHECKS_KIND = { kind: 'checks', schemaVersion: 1 } as const
export const checksFileSchema = z.object({
  checks: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    run: z.string().min(1),
    timeoutSeconds: z.number().int().positive().max(3600).default(600),
    /** Globs (GitHub Actions' `paths`): the check runs only when the change touches one or it failed earlier in the Work; without it, always. */
    paths: z.array(z.string().min(1)).min(1).optional(),
    /** Ignored: read for old files and old `checks@1` (a verdict reason notes it). */
    red: z.enum(['pass', 'fail']).optional(),
  }).strict()).min(1).max(20),
}).strict()
export const checksSchema = z.object({
  name: z.string(),
  source: z.object({ repository: z.string(), commit: z.string(), path: z.literal(CHECKS_FILE) }).strict(),
  checks: checksFileSchema.shape.checks,
}).strict()
export type Checks = z.infer<typeof checksSchema>

export const CHECK_RUN_KIND = { kind: 'check-run', schemaVersion: 1 } as const
export const checkRunSchema = z.object({
  name: z.string(),
  run: z.string(),
  commit: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  /** Xvfb and Chrome processes the check started and left running (stopped by the verifier), as `name pid N`. */
  leftovers: z.array(z.string()).optional(),
  /** The names (never the values) of the machine-level `checkEnv` variables the check was given. */
  checkEnv: z.array(z.string()).optional(),
  durationMs: z.number().int().nonnegative(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
}).strict()

/** The verifiers row's `checkEnv`: variables every check is given on top of its minimal environment (Item df-2). */
export const checkEnvSchema = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string())
  .refine((env) => !['HOME', 'PATH', 'CI'].some((k) => k in env), { message: 'HOME, PATH and CI cannot be set' })

/** A display server or browser: what a check's own tests leak, and what then holds a Worker's pipes and profile. */
const LEAKED = /^(Xvfb|chrome|chromium|chrome-headless-shell)$/

/**
 * The Xvfb and Chrome processes a check left running: those of this user whose environment carries the check's own
 * throwaway HOME (children keep it, and a leaked process is reparented, so its ancestry is no help). Each is killed.
 */
export function stopLeftovers(home: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const name = readFileSync(`/proc/${entry}/comm`, 'utf8').trim()
      if (!LEAKED.test(name) || !readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) continue
      process.kill(Number(entry), 'SIGKILL')
      found.push(`${name} pid ${entry}`)
    } catch {
      // Gone already, another user's, or no /proc (not Linux): nothing to name.
    }
  }
  return found
}

/** Whether a check runs for a change touching `touched` (paths relative to the repository): always without `paths`. */
export const selected = (check: { paths?: string[] }, touched: readonly string[]): boolean =>
  !check.paths || touched.some((file) => check.paths!.some((glob) => matchesGlob(file, glob)))

/** The throwaway directory (and HOME) of one verify attempt: its name carries the attempt ID, so a later Host can tell whether the run is gone. */
const scratchOf = (attemptId: string): string => join(tmpdir(), `system-checks-${attemptId.replace(/[^A-Za-z0-9-]/g, '-')}`)

/** Whether any process of this user has `home` as its HOME: what a check, and whatever it started, still running looks like. */
function anyWithHome(home: string): boolean {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) return true
    } catch {
      // Gone already or another user's.
    }
  }
  return false
}

const tail = (text: string) => (text.length > TAIL ? text.slice(-TAIL) : text)

function contentOf<T>(artifacts: Artifacts, id: string, kind: string): T {
  const read = artifacts.get(id)
  if (read.state !== 'stored' || read.envelope.kind !== kind) throw new Error(`${id} is not a stored ${kind} Artifact`)
  return read.envelope.content as T
}

export function requiredChecks(artifacts: Artifacts, spawner: Spawner, now: () => number = Date.now, checkEnv: Record<string, string> = {}, maxConcurrentChecks?: number): VerifierPort {
  const given = checkEnvSchema.safeParse(checkEnv)
  if (!given.success) throw new Error(`checkEnv is invalid: ${given.error.issues.map((i) => `${i.path.join('.')}${i.path.length ? ': ' : ''}${i.message}`).join('; ')}`)
  const extra = Object.keys(given.data)
  const producer = { type: 'verifier' as const, ref: 'code.required-checks' }
  const diffNames = async (repository: string, from: string, to: string): Promise<string[]> =>
    from === to ? [] : (await git(repository, ['diff', '--name-only', '--no-renames', from, to])).split('\n').filter(Boolean)

  return {
    ref: 'code.required-checks',
    version: '1',
    capabilities: ['code.required-checks'],
    ...(maxConcurrentChecks === undefined ? {} : { maxConcurrentChecks }),
    // A check of a Host that died is gone when no process has its throwaway HOME any more.
    async gone(attemptId) { return !anyWithHome(scratchOf(attemptId)) },
    // A task on its own (code-checks.yaml alone) has its base commit checked as it is.
    accepts: ['git-tree', 'task'],
    async criteria({ name, input }) {
      // A typo must not silently mean "every check passes".
      if (!(CRITERIA_NAMES as readonly string[]).includes(name)) throw new Error(`unknown criteria ${name} for code.required-checks; known: ${CRITERIA_NAMES.join(', ')}`)
      if (!input) throw new Error('the Work has no input task naming a repository')
      // The checks come from a base the Worker did not write, never from the change itself.
      const read = artifacts.get(input)
      if (read.state !== 'stored' || read.envelope.kind !== TASK_KIND.kind) throw new Error('the checks are pinned from a task with a base commit (system task new --repo), not from the change itself')
      const task = read.envelope.content as Task
      if (!task.base) throw new Error('the input task has no base commit (system task new --repo)')
      const base = contentOf<GitTreeContent>(artifacts, task.base, 'git-tree')
      let text: string
      try {
        text = await git(base.repository, ['show', `${base.commit}:${CHECKS_FILE}`])
      } catch {
        throw new Error(`no ${CHECKS_FILE} at commit ${base.commit} of ${base.repository}`)
      }
      const parsed = checksFileSchema.safeParse(parse(text))
      if (!parsed.success) throw new Error(`${CHECKS_FILE} at ${base.commit} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      const content: Checks = { name, source: { repository: base.repository, commit: base.commit, path: CHECKS_FILE }, checks: parsed.data.checks }
      return (await artifacts.put({ ...CHECKS_KIND, content, inputs: [task.base], classification: 'operator-shared', producer })).id
    },
    async verify(request): Promise<VerifyResult> {
      const verdict = (v: VerifyResult['verdict'], reason: string, evidence: string[]): VerifyResult => ({ verdict: v, reason: ignoredRed && (v === 'pass' || v === 'fail') ? `${reason}; note: red: in ${CHECKS_FILE} is ignored` : reason, subject: request.subject, criteria: request.criteria, evidence })
      const subject = artifacts.get(request.subject)
      const treeId = subject.state === 'stored' && subject.envelope.kind === TASK_KIND.kind ? (subject.envelope.content as Task).base ?? '' : request.subject
      const tree = contentOf<GitTreeContent>(artifacts, treeId, 'git-tree')
      const checks = contentOf<Checks>(artifacts, request.criteria, CHECKS_KIND.kind)
      const ignoredRed = checks.checks.some((check) => check.red)
      const scratch = scratchOf(request.attemptId)
      rmSync(scratch, { recursive: true, force: true })
      mkdirSync(scratch)
      const worktree = join(scratch, 'work')
      try {
        await addWorktree(tree.repository, worktree, tree.commit)
      } catch (error) {
        rmSync(scratch, { recursive: true, force: true })
        return verdict('error', `could not check out ${tree.commit}: ${(error as Error).message}`, [])
      }
      const evidence: string[] = []
      const failed: string[] = []
      const ran: string[] = []
      const skipped: string[] = []
      let flaky = ''
      try {
        // The repository's Node first on PATH, whatever the Host's PATH has (PROP-0007 decision 3).
        let bin: string | undefined
        try {
          bin = nodeBin(worktree)
        } catch (error) {
          return verdict('error', (error as Error).message, [])
        }
        const path = [bin, process.env.PATH].filter(Boolean).join(':')
        // What the change touches against the base its checks were pinned from (PROP-0007 decision 5); a commit checked as it is runs them all.
        // A tree that names its parent is a change from that commit (a captured change; a release against the running one); otherwise from the commit the checks were pinned from.
        // It is also a change from the Task's base, so a reopened step's second attempt is selected by everything changed since the base, not only since the previous attempt.
        const from = tree.parent ?? checks.source.commit
        const asItIs = tree.commit === from && tree.commit === checks.source.commit
        const touched = asItIs ? [] : [...new Set([...await diffNames(tree.repository, from, tree.commit), ...await diffNames(tree.repository, checks.source.commit, tree.commit)])]
        // A check that failed in an earlier verdict of this verify step in the Work runs again, whatever the diff selects.
        const failedBefore = new Set<string>()
        for (const id of request.earlier ?? []) {
          const read = artifacts.get(id)
          if (read.state !== 'stored' || read.envelope.kind !== CHECK_RUN_KIND.kind) continue
          const run = read.envelope.content as z.infer<typeof checkRunSchema>
          if (run.exitCode !== 0 || run.timedOut || run.leftovers?.length) failedBefore.add(run.name)
        }
        /** One check on one commit's worktree: the change and the base run it the same way, so "fails" means the same on both. */
        const runCheck = async (check: Checks['checks'][number], cwd: string, commit: string): Promise<{ id: string; failed?: string; ms: number }> => {
          const started = now()
          // `timeout` interrupts the whole group first, so a test runner says what it was running; the abort is the backstop.
          const backstop = AbortSignal.timeout((check.timeoutSeconds + 20) * 1000)
          const spawned = spawner.spawn({
            argv: ['timeout', '-s', 'INT', '-k', '10', String(check.timeoutSeconds), '/bin/sh', '-c', check.run], cwd, signal: backstop, graceMs: 5000,
            env: { ...Object.fromEntries(Object.keys(process.env).map((k) => [k, undefined])), ...given.data, LANG: process.env.LANG, PATH: path, HOME: scratch, CI: '1' },
          })
          const outcome = await spawned.done
          const leftovers = stopLeftovers(scratch)
          const output = `${spawned.stdout()}\n${spawned.stderr()}`
          const run = {
            name: check.name, run: check.run, commit, exitCode: outcome.exitCode, signal: outcome.signal,
            timedOut: backstop.aborted || outcome.exitCode === 124, durationMs: Math.max(0, Math.round(now() - started)),
            stdoutTail: tail(spawned.stdout()), stderrTail: tail(spawned.stderr()), ...(leftovers.length ? { leftovers } : {}), ...(extra.length ? { checkEnv: extra } : {}),
          }
          const id = (await artifacts.put({ ...CHECK_RUN_KIND, content: run, inputs: [request.subject, request.criteria], classification: 'local-private', producer })).id
          let failure: string | undefined
          if (run.timedOut) {
            const running = interrupted(output)
            failure = running.length ? `${check.name}: timed out after ${check.timeoutSeconds} s while running ${running.join(', ')}` : `${check.name} (timed out after ${check.timeoutSeconds} s)`
          } else if (run.exitCode !== 0) {
            const first = firstFailure(output)
            failure = first ? `${check.name}: ${first}` : `${check.name} (exit ${run.exitCode ?? run.signal})`
          } else if (leftovers.length) {
            failure = `${check.name} (left running: ${leftovers.join(', ')})`
          }
          return { id, ...(failure ? { failed: failure } : {}), ms: run.durationMs }
        }
        const failedNames: string[] = []
        const chosen = checks.checks.filter((check) => asItIs || selected(check, touched) || failedBefore.has(check.name))
        for (const check of checks.checks) if (!chosen.includes(check)) skipped.push(check.name)
        for (const check of chosen) {
          const result = await runCheck(check, worktree, tree.commit)
          evidence.push(result.id)
          ran.push(`${check.name} ${(result.ms / 1000).toFixed(1)} s${!asItIs && !selected(check, touched) ? ' (failed earlier)' : ''}`)
          if (result.failed) {
            failed.push(result.failed)
            failedNames.push(check.name)
          }
        }
        // A check the change fails is run again on the base (PROP-0007 / df-25): when the base fails it too, the change is not to blame.
        // The base shares the change's HOME (one scratch), so a check that keeps state there could differ from a clean run; accepted.
        // The base is the commit the checks were pinned from, not `from`: a further attempt on a failed change has that change as its parent, and it fails the check too.
        const base = checks.source.commit
        /** Which of `names` fail on the base, running the chosen checks up to the last of them (the ones before are its prerequisites, such as install and build, and evidence too); undefined when the base cannot be checked out. */
        const failingOnBase = async (names: string[]): Promise<Set<string> | undefined> => {
          const baseTree = join(scratch, 'base')
          try {
            await addWorktree(tree.repository, baseTree, base)
          } catch {
            return undefined
          }
          try {
            const last = Math.max(...names.map((name) => chosen.findIndex((c) => c.name === name)))
            const baseFailed = new Set<string>()
            for (const check of chosen.slice(0, last + 1)) {
              const result = await runCheck(check, baseTree, base)
              evidence.push(result.id)
              if (result.failed) baseFailed.add(check.name)
            }
            return baseFailed
          } finally {
            await removeWorktree(tree.repository, baseTree)
          }
        }
        /** The one re-run (sc-13): the named checks again on the change, in file order; each one's failure, undefined when it passes. */
        const rerunOnChange = async (names: string[]): Promise<Map<string, string | undefined>> => {
          const again = new Map<string, string | undefined>()
          for (const check of chosen.filter((c) => names.includes(c.name))) {
            const result = await runCheck(check, worktree, tree.commit)
            evidence.push(result.id)
            again.set(check.name, result.failed)
          }
          return again
        }
        if (failedNames.length && !asItIs && base !== tree.commit) {
          const baseFailed = await failingOnBase(failedNames)
          if (baseFailed && failedNames.every((name) => baseFailed.has(name))) {
            // Inconclusive: run the failing checks once more, on the change and then on the base, before the verdict holds the Work (sc-13).
            const firstFailed = failed.join('; ')
            const again = await rerunOnChange(failedNames)
            const still = failedNames.filter((name) => again.get(name))
            failed.splice(0, failed.length, ...still.map((name) => again.get(name)!))
            if (!still.length) {
              flaky = `re-run once: ${failedNames.join(', ')} failed, then passed on the change (flaky); first run: ${firstFailed}; `
            } else {
              const baseAgain = await failingOnBase(still)
              if (!baseAgain || still.every((name) => baseAgain.has(name))) {
                return verdict('inconclusive', `${still.map((name) => `${name}: the base fails it too (base ${base})`).join('; ')}, also on a re-run once; failed on the change: ${firstFailed}; and again: ${failed.join('; ')}`, evidence)
              }
              return verdict('fail', `failed: ${failed.join('; ')} (the base passed on re-run once; the first run failed on both: ${firstFailed})`, evidence)
            }
          }
        }
      } finally {
        await removeWorktree(tree.repository, worktree)
        rmSync(scratch, { recursive: true, force: true })
      }
      const which = `run: ${ran.join(', ')}${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}`
      return failed.length
        ? verdict('fail', `failed: ${failed.join('; ')}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`, evidence)
        : verdict('pass', `${flaky}all ${ran.length} check(s) run passed on ${tree.commit}; ${which}`, evidence)
    },
  }
}
