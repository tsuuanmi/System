/**
 * `code.required-checks`: run a repository's required check commands on a
 * fresh worktree of the exact commit under judgment.
 *
 * Criteria are pinned at admission from `.system/checks.yaml` **at the task's
 * base commit**, so a Worker cannot weaken them by editing that file. Each
 * check runs `sh -c <run>` in the worktree with a minimal environment and its
 * own timeout; its exit, duration and output tails are one evidence Artifact.
 * Verdict: `pass` when every check exits 0 and leaves no Xvfb or Chrome running (it is named and killed), `fail` when any does not (a
 * timeout is a failure), `inconclusive` when every failing check fails on the base commit too (run again by name, up to the
 * last failed check; the evidence holds both runs; not for a subject that is the base itself), `error` when the checks could not be run at all.
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
const TAIL = 16 * 1024

export const CHECKS_KIND = { kind: 'checks', schemaVersion: 1 } as const
export const checksFileSchema = z.object({
  checks: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    run: z.string().min(1),
    timeoutSeconds: z.number().int().positive().max(3600).default(600),
    /** Globs (GitHub Actions' `paths`): the check runs only when the change touches one; without it, always. */
    paths: z.array(z.string().min(1)).min(1).optional(),
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

/** The verifiers row's `checkEnv`: variables every check is given on top of its minimal environment (DF2c). */
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
      const verdict = (v: VerifyResult['verdict'], reason: string, evidence: string[]): VerifyResult => ({ verdict: v, reason, subject: request.subject, criteria: request.criteria, evidence })
      const subject = artifacts.get(request.subject)
      const treeId = subject.state === 'stored' && subject.envelope.kind === TASK_KIND.kind ? (subject.envelope.content as Task).base ?? '' : request.subject
      const tree = contentOf<GitTreeContent>(artifacts, treeId, 'git-tree')
      const checks = contentOf<Checks>(artifacts, request.criteria, CHECKS_KIND.kind)
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
        const from = tree.parent ?? checks.source.commit
        const asItIs = tree.commit === from
        const touched = asItIs ? [] : (await git(tree.repository, ['diff', '--name-only', from, tree.commit])).split('\n').filter(Boolean)
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
          } else if (leftovers.length) failure = `${check.name} (left running: ${leftovers.join(', ')})`
          return { id, ...(failure ? { failed: failure } : {}), ms: run.durationMs }
        }
        const failedNames: string[] = []
        const chosen = checks.checks.filter((check) => asItIs || selected(check, touched))
        for (const check of checks.checks) if (!chosen.includes(check)) skipped.push(check.name)
        for (const check of chosen) {
          const result = await runCheck(check, worktree, tree.commit)
          evidence.push(result.id)
          ran.push(`${check.name} ${(result.ms / 1000).toFixed(1)} s`)
          if (result.failed) {
            failed.push(result.failed)
            failedNames.push(check.name)
          }
        }
        // A check the change fails is run again on the base (PROP-0007 / df-25): when the base fails it too, the change is not to blame.
        // The base shares the change's HOME (one scratch), so a check that keeps state there could differ from a clean run; accepted.
        if (failedNames.length && !asItIs) {
          let baseTree: string | undefined
          try {
            baseTree = join(scratch, 'base')
            await addWorktree(tree.repository, baseTree, from)
          } catch {
            baseTree = undefined
          }
          if (baseTree) {
            try {
              // Up to the last check that failed on the change: the ones before it are its prerequisites (install, build) and are evidence too.
              const last = Math.max(...failedNames.map((name) => chosen.findIndex((c) => c.name === name)))
              const baseFailed = new Set<string>()
              for (const check of chosen.slice(0, last + 1)) {
                const result = await runCheck(check, baseTree, from)
                evidence.push(result.id)
                if (result.failed) baseFailed.add(check.name)
              }
              if (failedNames.every((name) => baseFailed.has(name))) {
                return verdict('inconclusive', `${failedNames.map((name) => `${name}: the base fails it too (base ${from})`).join('; ')}; failed on the change: ${failed.join('; ')}`, evidence)
              }
            } finally {
              await removeWorktree(tree.repository, baseTree)
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
        : verdict('pass', `all ${ran.length} check(s) run passed on ${tree.commit}; ${which}`, evidence)
    },
  }
}
