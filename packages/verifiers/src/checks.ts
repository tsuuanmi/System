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
/** Criteria names that change what a verdict means (the name is pinned in the `checks@1` Artifact); any other name is every selected check passing. */
export const RED = 'red-v1'
export const TESTS_FROZEN = 'tests-frozen-v1'
const TAIL = 16 * 1024

export const CHECKS_KIND = { kind: 'checks', schemaVersion: 1 } as const
export const checksFileSchema = z.object({
  checks: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    run: z.string().min(1),
    timeoutSeconds: z.number().int().positive().max(3600).default(600),
    /** Globs (GitHub Actions' `paths`): the check runs only when the change touches one; without it, always. */
    paths: z.array(z.string().min(1)).min(1).optional(),
    /** Under `red-v1` (the tests step's change, before any code): `pass` must still pass, `fail` (absent) is where the new tests fail. */
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
  const diffNames = async (repository: string, from: string, to: string): Promise<string[]> =>
    from === to ? [] : (await git(repository, ['diff', '--name-only', '--no-renames', from, to])).split('\n').filter(Boolean)

  /**
   * `tests-frozen-v1`: the subject (the implement step's change) leaves every file the tests step's change (input
   * `tests`) added, modified or deleted as that step left it, compared with its commit; files of its own, new tests
   * included, are allowed. One `check-run@1` records the git command and the files it found changed.
   */
  async function testsFrozen(testsId: string | undefined, tree: GitTreeContent, verdict: (v: VerifyResult['verdict'], reason: string, evidence: string[]) => VerifyResult): Promise<VerifyResult> {
    if (!testsId) return verdict('error', `${TESTS_FROZEN} needs the tests step's change as input "tests"`, [])
    const tests = contentOf<GitTreeContent>(artifacts, testsId, 'git-tree')
    if (!tests.parent) return verdict('error', `the tests step's change ${tests.commit} names no parent: what it wrote is unknown`, [])
    const started = now()
    const written = new Set(await diffNames(tree.repository, tests.parent, tests.commit))
    const changed = (await diffNames(tree.repository, tests.commit, tree.commit)).filter((file) => written.has(file))
    const run = {
      name: 'tests-frozen', run: `git diff --name-only --no-renames ${tests.commit} ${tree.commit}`, commit: tree.commit, exitCode: changed.length ? 1 : 0, signal: null,
      timedOut: false, durationMs: Math.max(0, Math.round(now() - started)), stdoutTail: tail(changed.map((file) => `${file}\n`).join('')), stderrTail: '',
    }
    const evidence = [(await artifacts.put({ ...CHECK_RUN_KIND, content: run, inputs: [testsId], classification: 'local-private', producer })).id]
    return changed.length
      ? verdict('fail', `failed: tests-frozen: the change changed what the tests step wrote: ${changed.join(', ')} (compared with ${tests.commit})`, evidence)
      : verdict('pass', `tests-frozen: none of the ${written.size} file(s) the tests step wrote changed between ${tests.commit} and ${tree.commit}`, evidence)
  }

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
      if (checks.name === TESTS_FROZEN) return testsFrozen(request.inputs?.tests, tree, verdict)
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
        const runCheck = async (check: Checks['checks'][number], cwd: string, commit: string): Promise<{ id: string; failed?: string; leftover: boolean; ms: number }> => {
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
          let leftover = false
          if (run.timedOut) {
            const running = interrupted(output)
            failure = running.length ? `${check.name}: timed out after ${check.timeoutSeconds} s while running ${running.join(', ')}` : `${check.name} (timed out after ${check.timeoutSeconds} s)`
          } else if (run.exitCode !== 0) {
            const first = firstFailure(output)
            failure = first ? `${check.name}: ${first}` : `${check.name} (exit ${run.exitCode ?? run.signal})`
          } else if (leftovers.length) {
            failure = `${check.name} (left running: ${leftovers.join(', ')})`
            leftover = true
          }
          return { id, ...(failure ? { failed: failure } : {}), leftover, ms: run.durationMs }
        }
        const failedNames: string[] = []
        /** Each check run and why it failed, if it did; `leftover` when only what it left running failed it. */
        const results: { name: string; red?: 'pass' | 'fail'; failure?: string; leftover: boolean }[] = []
        const chosen = checks.checks.filter((check) => asItIs || selected(check, touched))
        for (const check of checks.checks) if (!chosen.includes(check)) skipped.push(check.name)
        for (const check of chosen) {
          const result = await runCheck(check, worktree, tree.commit)
          evidence.push(result.id)
          ran.push(`${check.name} ${(result.ms / 1000).toFixed(1)} s`)
          results.push({ name: check.name, red: check.red, failure: result.failed, leftover: result.leftover })
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
        if (checks.name === RED) {
          // The tests step's change, before any code: what must still pass does, and the new tests fail somewhere the base does not.
          // A check that leaves a process running is broken whatever its `red`.
          const skips = skipped.length ? `; skipped: ${skipped.join(', ')}` : ''
          const broke = results.filter((r) => r.failure && (r.red === 'pass' || r.leftover)).map((r) => r.failure!)
          if (broke.length) return verdict('fail', `failed: must pass with only the new tests: ${broke.join('; ')}${skips}`, evidence)
          const candidates = results.filter((r) => r.failure && r.red !== 'pass')
          if (!candidates.length) return verdict('fail', `failed: no check with red: fail failed on ${tree.commit}, so the new tests prove nothing; run: ${ran.join(', ')}${skips}`, evidence)
          if (base === tree.commit) return verdict('fail', `failed: the change is the base ${base}: there are no new tests`, evidence)
          // Only a check that passes on the base is red because of the new tests (df-25's rule, applied to red-v1).
          const onBase = await failingOnBase(candidates.map((r) => r.name))
          if (!onBase) return verdict('error', `could not check out the base ${base} to tell the new tests' failures from the base's`, evidence)
          const red = candidates.filter((r) => !onBase.has(r.name)).map((r) => r.failure!)
          const passed = results.filter((r) => !r.failure).map((r) => r.name)
          if (!red.length) return verdict('inconclusive', `every check that failed fails on the base ${base} too, so the new tests' failures cannot be told apart: ${candidates.map((r) => r.failure!).join('; ')}${skips}`, evidence)
          return verdict('pass', `red on ${tree.commit}: failed as it should, and passes on the base: ${red.join('; ')}; passed: ${passed.join(', ') || 'none'}${skips}`, evidence)
        }
        if (failedNames.length && !asItIs && base !== tree.commit) {
          const baseFailed = await failingOnBase(failedNames)
          if (baseFailed && failedNames.every((name) => baseFailed.has(name))) {
            return verdict('inconclusive', `${failedNames.map((name) => `${name}: the base fails it too (base ${base})`).join('; ')}; failed on the change: ${failed.join('; ')}`, evidence)
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
