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
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, matchesGlob, normalize, sep } from 'node:path'
import type { Spawner } from '@system/agents/contract'
import type { Artifacts } from '@system/artifacts/contract'
import { addWorktree, git, removeWorktree } from '@system/git'
import { type GitTreeContent, type Task, type VerifyResult, verifierRerunReason } from '@system/work'
import { TASK_KIND, type VerifierPort } from '@system/work/contract'
import { parse } from 'yaml'
import { failureLine, interrupted, nodeBin } from './reasons.ts'
import { z } from 'zod'

export const CHECKS_FILE = '.system/checks.yaml'
/** The criteria names, pinned in the `checks@1` Artifact, and what each verdict means; any other name refuses admission. */
const REPO_CHECKS = 'repo-checks-v1'
/** `repo-checks-v1` with one difference: a run where no check ran (every one filtered out by `paths`) is `inconclusive`, not `pass`. */
export const REPO_CHECKS_V2 = 'repo-checks-v2'
/** `repo-checks-v2` for a release checked against the running one (`system update`): the event of its run is `release`. */
export const REPO_CHECKS_RELEASE = 'repo-checks-release-v1'
/** The events a check can name with `on:` (GitHub Actions' `on:`): a Work's checks step, the merge queue's re-check, a release check by `system update`. */
const CHECK_EVENTS = ['pull_request', 'merge_group', 'release'] as const
type CheckEvent = (typeof CHECK_EVENTS)[number]
/**
 * The small mode (ro-15, Satisfied): the Task's base is not judged by the repository's checks but by exactly the tests the verify step's input
 * `tests` names (one `<test file> "<test name>"` per line), run with `node --test-name-pattern <file>` (the file itself, not `--test`, which counts the file as a test that passed) after the pinned setup checks named in `SETUP_CHECKS`.
 * A listed test that matches nothing is a failure, so a wrong name never passes.
 */
const SATISFIED_TESTS = 'satisfied-tests-v1'
const SETUP_CHECKS = ['install', 'build']
const CRITERIA_NAMES = [REPO_CHECKS, REPO_CHECKS_V2, REPO_CHECKS_RELEASE, SATISFIED_TESTS] as const
/** The event a verify step's criteria name stands for when its request names none: `release` for the release criteria, otherwise `pull_request`. */
const eventOfCriteria = (name: string): CheckEvent => name === REPO_CHECKS_RELEASE ? 'release' : 'pull_request'
const TAIL = 16 * 1024

export const CHECKS_KIND = { kind: 'checks', schemaVersion: 1 } as const
/** The top-level keys of a checks file and the keys of one check: the one place that lists them. The schemas below must have exactly these keys (`satisfies`), and criteria-pins.test.ts reads them from `main` (Escaped defect 7: a file uses only keys the last release knows). */
export const CHECKS_FILE_KEYS = ['checks', 'afterInstall', 'gates'] as const
export const CHECK_KEYS = ['name', 'run', 'timeoutSeconds', 'paths', 'on', 'red'] as const
const checkSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  run: z.string().min(1),
  timeoutSeconds: z.number().int().positive().max(3600).default(600),
  /** Globs (GitHub Actions' `paths`, with `!` exclusions: the last pattern matching a file decides): the check runs only when the change touches an included file or it failed earlier in the Work; without it, always. */
  paths: z.array(z.string().min(1)).min(1).optional(),
  /** The events the check runs on (GitHub Actions' `on:`); without it, on every event. */
  on: z.array(z.enum(CHECK_EVENTS)).min(1).optional(),
  /** Ignored: read for old files and old `checks@1` (a verdict reason notes it). */
  red: z.enum(['pass', 'fail']).optional(),
} satisfies Record<(typeof CHECK_KEYS)[number], z.ZodTypeAny>).strict()
export const checksFileSchema = z.object({
  checks: z.array(checkSchema).min(1).max(20),
  /** Item fl-5: checks `system update` runs on the installed release (`release.install-check`); same schema as `checks`. */
  afterInstall: z.array(checkSchema).min(1).max(20).optional(),
  /** Item gate-1: globs of paths whose change is held for the Operator's Approval after its checks pass (read from the base commit by the merge queue, packages/effects). */
  gates: z.array(z.string().min(1)).optional(),
} satisfies Record<(typeof CHECKS_FILE_KEYS)[number], z.ZodTypeAny>).strict()
/** The checks of a `.system/checks.yaml` text (and its `afterInstall` list when it has one), or why the schema refuses it (`checks.yaml` as `bootstrap check` and admission both read it). */
export function parseChecksFile(text: string): { checks: Checks['checks']; afterInstall?: Checks['checks'] } | { problem: string } {
  const parsed = checksFileSchema.safeParse(parse(text))
  return parsed.success ? { checks: parsed.data.checks, ...(parsed.data.afterInstall ? { afterInstall: parsed.data.afterInstall } : {}) } : { problem: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
}
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
  /** Item nodever-1: the Node and pnpm the check ran with, and the Node's path (absent in older records, and pnpm when it could not be run). */
  nodeVersion: z.string().optional(),
  nodePath: z.string().optional(),
  pnpmVersion: z.string().optional(),
  /** Item chk-reuse-1: the hash of this check's inputs (its definition, the files its `paths` select, the toolchain); a pass with a key can be reused by a later run with the same key. */
  key: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
}).strict()

/** The verifiers row's `checkEnv`: variables every check is given on top of its minimal environment (Item df-2). */
export const checkEnvSchema = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string())
  .refine((env) => !['HOME', 'PATH', 'CI'].some((k) => k in env), { message: 'HOME, PATH and CI cannot be set' })

/** The first `node` on `path` that runs: where it is and its version (what a check's `node` is). */
function nodeOn(path: string): { path: string; version: string } | undefined {
  for (const dir of path.split(':').filter(Boolean)) {
    const candidate = join(dir, 'node')
    if (candidate === process.execPath) return { path: candidate, version: process.version }
    try {
      return { path: candidate, version: execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim() }
    } catch {
      // Not here or not executable; try the next directory on PATH.
    }
  }
  return undefined
}

/** The pnpm a check's `pnpm` is on `path`, run as a check runs it (a throwaway HOME); undefined when it cannot be run. */
function pnpmOn(path: string, home: string): string | undefined {
  const bin = path.split(':').filter(Boolean).map((dir) => join(dir, 'pnpm')).find((candidate) => existsSync(candidate))
  if (!bin) return undefined
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: path, HOME: home, CI: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } }).trim() || undefined
  } catch {
    return undefined
  }
}

/** Item nodever-1: the first `checkEnv` variable named `*_HOME` or `*_DIR` whose path does not exist, as `NAME=path`. */
function missingEnvPath(env: Record<string, string>): string | undefined {
  const name = Object.keys(env).find((k) => /(_HOME|_DIR)$/.test(k) && !existsSync(env[k]!))
  return name ? `${name}=${env[name]}` : undefined
}

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

/**
 * Whether a check runs for `event` on a change touching `touched` (paths relative to the repository): always without `on` and `paths`.
 * `on` names the events the check runs on; both must select it.
 * As GitHub Actions: the patterns are read in order, a file is included when the last pattern matching it is a positive one and
 * excluded when it is a `!` pattern; the check runs when at least one touched file is included.
 */
export const selected = (check: { paths?: string[]; on?: readonly CheckEvent[] }, touched: readonly string[], event: CheckEvent = 'pull_request'): boolean => {
  if (check.on && !check.on.includes(event)) return false
  const paths = check.paths
  if (!paths) return true
  return touched.some((file) => pathIncluded(paths, file))
}

/** Whether `paths` (read in order, `!` excludes, the last pattern matching `file` decides) include `file`. */
const pathIncluded = (paths: readonly string[], file: string): boolean => paths.reduce((in_, glob) => glob.startsWith('!') ? (matchesGlob(file, glob.slice(1)) ? false : in_) : (matchesGlob(file, glob) ? true : in_), false)

/** Item chk-reuse-1: the files whose change invalidates every check's pass when the checks install dependencies: package manifests and the lockfile. */
const isManifest = (file: string): boolean => /(^|\/)package\.json$/.test(file) || file === 'pnpm-lock.yaml' || file === 'pnpm-workspace.yaml'

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

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/** The tests a `satisfied-tests-v1` run names: `<test file> "<test name>"` per line, files relative to the repository and inside it. */
function parseTests(text: string): { file: string; name: string }[] {
  const tests = text.split('\n').map((line) => line.trimEnd()).filter(Boolean).map((line) => {
    const match = /^(\S+) "(.+)"$/.exec(line)
    if (!match) throw new Error(`not a test line (<test file> "<test name>"): ${line}`)
    const file = normalize(match[1]!)
    if (isAbsolute(file) || file.split(sep).includes('..')) throw new Error(`the test file ${match[1]} is not inside the repository`)
    return { file, name: match[2]! }
  })
  if (!tests.length) throw new Error('no test named')
  if (tests.length > 50) throw new Error(`${tests.length} tests named; at most 50`)
  return tests
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
   * Item chk-reuse-1: the key of a check on a commit is the hash of its definition, the toolchain (the Node on PATH, the pnpm of `packageManager`) and the tree of the
   * files its `paths` select (every file without `paths`), plus the package manifests and the lockfile when the checks install dependencies. `find` returns the
   * earlier passing run with that key and a `pass` verdict that holds it as evidence (the controller stores verdicts, so a run no verdict names is not reused).
   */
  const reuser = (repository: string, checks: Checks, extraNames: string[], path: string) => {
    const lists = new Map<string, Promise<{ file: string; entry: string }[]>>()
    const listOf = (commit: string) => {
      if (!lists.has(commit)) {
        lists.set(commit, git(repository, ['ls-tree', '-r', '-z', commit]).then((out) => out.split('\0').filter(Boolean).map((line) => ({ file: line.slice(line.indexOf('\t') + 1), entry: line }))))
      }
      return lists.get(commit)!
    }
    let toolchain: string | undefined
    const toolchainOf = async (commit: string): Promise<string> => {
      if (toolchain !== undefined) return toolchain
      const node = nodeOn(path)?.version ?? ''
      let pnpm = ''
      try {
        pnpm = String((JSON.parse(await git(repository, ['show', `${commit}:package.json`])) as { packageManager?: string }).packageManager ?? '')
      } catch {
        // No readable package.json: no pnpm version to record.
      }
      toolchain = `${node} ${pnpm}`
      return toolchain
    }
    const installs = checks.checks.some((check) => SETUP_CHECKS.includes(check.name))
    const keyOf = async (check: Checks['checks'][number], commit: string): Promise<string> => {
      const files = (await listOf(commit)).filter(({ file }) => (check.paths ? pathIncluded(check.paths, file) : true) || (installs && isManifest(file))).map(({ entry }) => entry).sort()
      const { name, run, timeoutSeconds, paths, on } = check
      return createHash('sha256').update(JSON.stringify({ definition: { name, run, timeoutSeconds, paths, on }, env: extraNames, toolchain: await toolchainOf(commit), files })).digest('hex')
    }
    let passes: Map<string, string> | undefined
    const find = async (check: Checks['checks'][number], commit: string): Promise<{ run: string; verdict: string } | undefined> => {
      const key = await keyOf(check, commit)
      if (!passes) {
        // Evidence ID to the pass verdict that holds it (a verdict that ran it, over one that itself reused it).
        passes = new Map()
        for (const id of artifacts.idsByKind('verdict')) {
          const read = artifacts.get(id)
          if (read.state !== 'stored') continue
          const verdict = read.envelope.content as { verdict: string; reason: string; evidence: string[]; verifier: { ref: string } }
          if (verdict.verdict !== 'pass' || verdict.verifier.ref !== 'code.required-checks') continue
          for (const evidence of verdict.evidence) if (!passes.has(evidence) || !verdict.reason.includes('(reused ')) passes.set(evidence, id)
        }
      }
      for (const id of artifacts.idsByKind(CHECK_RUN_KIND.kind)) {
        const verdict = passes.get(id)
        if (!verdict) continue
        const read = artifacts.get(id)
        if (read.state !== 'stored') continue
        const run = read.envelope.content as z.infer<typeof checkRunSchema>
        if (run.key === key && run.name === check.name && run.exitCode === 0 && !run.timedOut && !run.leftovers?.length) return { run: id, verdict }
      }
      return undefined
    }
    return { keyOf, find }
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
      const parsed = parseChecksFile(text)
      if ('problem' in parsed) throw new Error(`${CHECKS_FILE} at ${base.commit} is invalid: ${parsed.problem}`)
      const content: Checks = { name, source: { repository: base.repository, commit: base.commit, path: CHECKS_FILE }, checks: parsed.checks }
      return (await artifacts.put({ ...CHECKS_KIND, content, inputs: [task.base], classification: 'operator-shared', producer })).id
    },
    async verify(request): Promise<VerifyResult> {
      const verdict = (v: VerifyResult['verdict'], reason: string, evidence: string[], cause?: VerifyResult['cause']): VerifyResult => ({ ...(cause ? { cause } : {}), verdict: v, reason: ignoredRed && (v === 'pass' || v === 'fail') ? `${reason}; note: red: in ${CHECKS_FILE} is ignored` : reason, subject: request.subject, criteria: request.criteria, evidence })
      const subject = artifacts.get(request.subject)
      const treeId = subject.state === 'stored' && subject.envelope.kind === TASK_KIND.kind ? (subject.envelope.content as Task).base ?? '' : request.subject
      const tree = contentOf<GitTreeContent>(artifacts, treeId, 'git-tree')
      const checks = contentOf<Checks>(artifacts, request.criteria, CHECKS_KIND.kind)
      const ignoredRed = checks.checks.some((check) => check.red)
      // Item nodever-1: a configured *_HOME or *_DIR that is not there fails now, not later inside a check.
      const missing = missingEnvPath(given.data)
      if (missing) return verdict('error', `checkEnv names a path that does not exist: ${missing} (fix the verifiers row's checkEnv)`, [])
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
      /** reopen-1: per failed check, whether the base fails it too or the change broke it; set when the base was run. */
      let baseNote = ''
      try {
        // The repository's Node first on PATH, whatever the Host's PATH has (PROP-0007 decision 3).
        let bin: string | undefined
        try {
          bin = nodeBin(worktree)
        } catch (error) {
          return verdict('error', (error as Error).message, [])
        }
        const path = [bin, process.env.PATH].filter(Boolean).join(':')
        const node = nodeOn(path)
        const pnpmVersion = pnpmOn(path, scratch)
        const reuse = reuser(tree.repository, checks, extra, path)
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
          const key = SETUP_CHECKS.includes(check.name) ? undefined : await reuse.keyOf(check, commit)
          // `timeout` interrupts the whole group first, so a test runner says what it was running; the abort is the backstop.
          const backstop = AbortSignal.timeout((check.timeoutSeconds + 20) * 1000)
          const spawned = spawner.spawn({
            argv: ['timeout', '-s', 'INT', '-k', '10', String(check.timeoutSeconds), '/bin/sh', '-c', check.run], cwd, signal: backstop, graceMs: 5000,
            env: { ...Object.fromEntries(Object.keys(process.env).map((k) => [k, undefined])), ...given.data, SYSTEM_CHECK_BASE: checks.source.commit, LANG: process.env.LANG, PATH: path, HOME: scratch, CI: '1' },
          })
          const outcome = await spawned.done
          const leftovers = stopLeftovers(scratch)
          const output = `${spawned.stdout()}\n${spawned.stderr()}`
          const run = {
            name: check.name, run: check.run, commit, exitCode: outcome.exitCode, signal: outcome.signal,
            timedOut: backstop.aborted || outcome.exitCode === 124, durationMs: Math.max(0, Math.round(now() - started)),
            ...(key ? { key } : {}), stdoutTail: tail(spawned.stdout()), stderrTail: tail(spawned.stderr()), ...(leftovers.length ? { leftovers } : {}), ...(extra.length ? { checkEnv: extra } : {}),
            ...(node ? { nodeVersion: node.version, nodePath: node.path } : {}), ...(pnpmVersion ? { pnpmVersion } : {}),
          }
          const id = (await artifacts.put({ ...CHECK_RUN_KIND, content: run, inputs: [request.subject, request.criteria], classification: 'local-private', producer })).id
          let failure: string | undefined
          if (run.timedOut) {
            const running = interrupted(output)
            failure = running.length ? `${check.name}: timed out after ${check.timeoutSeconds} s while running ${running.join(', ')}` : `${check.name} (timed out after ${check.timeoutSeconds} s)`
          } else if (run.exitCode !== 0) {
            failure = failureLine(output, check.name, run.exitCode, run.signal, { stderr: spawned.stderr(), stdout: spawned.stdout() }, Object.values(given.data).filter((v): v is string => typeof v === 'string'))
          } else if (leftovers.length) {
            failure = `${check.name} (left running: ${leftovers.join(', ')})`
          }
          return { id, ...(failure ? { failed: failure } : {}), ms: run.durationMs }
        }
        if (checks.name === SATISFIED_TESTS) {
          let listed: ReturnType<typeof parseTests>
          try {
            const named = request.inputs?.tests
            if (!named) throw new Error('no input `tests` naming them')
            listed = parseTests(Buffer.from(await artifacts.readBytes(named)).toString('utf8'))
            for (const { file } of listed) if (!statSync(join(worktree, file), { throwIfNoEntry: false })?.isFile()) throw new Error(`no test file ${file} at ${tree.commit}`)
          } catch (error) {
            return verdict('error', `cannot run the named tests: ${(error as Error).message}`, [])
          }
          // The pinned setup checks, then exactly the named tests; a test counts only when it ran (`# pass` of at least one) and nothing failed.
          const plan = [
            ...checks.checks.filter((check) => SETUP_CHECKS.includes(check.name)),
            ...listed.map(({ file, name }, n) => {
              const pattern = `/(^| )${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$/`
              return { name: `${file} "${name}"`, timeoutSeconds: 300, run: `out="$HOME/test-${n}.out"; node --test-reporter=tap --test-name-pattern=${quote(pattern)} ${quote(file)} > "$out" 2>&1; s=$?; cat "$out"; [ "$s" -eq 0 ] && grep -Eq '^# pass [1-9]' "$out" && ! grep -Eq '^# fail [1-9]' "$out"` }
            }),
          ]
          for (const check of plan) {
            const result = await runCheck(check, worktree, tree.commit)
            evidence.push(result.id)
            ran.push(check.name)
            if (result.failed) failed.push(result.failed)
            if (result.failed && SETUP_CHECKS.includes(check.name)) break
          }
          return failed.length
            ? verdict('fail', `the named tests did not all pass on ${tree.commit}: ${failed.join('; ')}`, evidence)
            : verdict('pass', `the ${listed.length} named test(s) passed on ${tree.commit}: ${listed.map(({ file, name }) => `${file} "${name}"`).join(', ')}`, evidence)
        }
        const failedNames: string[] = []
        // The event comes from the request (the merge queue names `merge_group`), else from the criteria (`repo-checks-release-v1`), else `pull_request`.
        const event = request.event ?? eventOfCriteria(checks.name)
        const picked = (check: Checks['checks'][number]): boolean => asItIs ? !check.on || check.on.includes(event) : selected(check, touched, event)
        // The setup checks (install, build) still run when a later check chosen needs them, whatever `on` and `paths` say of them.
        const needsSetup = checks.checks.some((check) => !SETUP_CHECKS.includes(check.name) && (picked(check) || failedBefore.has(check.name)))
        const wanted = checks.checks.filter((check) => picked(check) || failedBefore.has(check.name) || (needsSetup && SETUP_CHECKS.includes(check.name)))
        // Item chk-reuse-1: a check whose inputs are byte-identical to an earlier pass is not run again (never on the release event); the setup checks are never reused (they make node_modules and dist for the later checks), and run only when a later check still runs.
        const reused = new Map<string, { run: string; verdict: string }>()
        if (event !== 'release') {
          for (const check of wanted) {
            if (SETUP_CHECKS.includes(check.name)) continue
            const found = await reuse.find(check, tree.commit)
            if (found) reused.set(check.name, found)
          }
        }
        const stillNeedsSetup = wanted.some((check) => !SETUP_CHECKS.includes(check.name) && !reused.has(check.name))
        const chosen = wanted.filter((check) => !reused.has(check.name) && (!SETUP_CHECKS.includes(check.name) || stillNeedsSetup))
        for (const check of checks.checks) if (!wanted.includes(check) || (SETUP_CHECKS.includes(check.name) && !chosen.includes(check))) skipped.push(check.name)
        for (const check of wanted) {
          const earlierPass = reused.get(check.name)
          if (earlierPass) {
            evidence.push(earlierPass.run)
            ran.push(`${check.name} pass (reused ${earlierPass.verdict})`)
            continue
          }
          if (!chosen.includes(check)) continue
          const result = await runCheck(check, worktree, tree.commit)
          evidence.push(result.id)
          ran.push(`${check.name} ${(result.ms / 1000).toFixed(1)} s${!picked(check) ? ' (failed earlier)' : ''}`)
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
          if (baseFailed && !failedNames.every((name) => baseFailed.has(name))) {
            baseNote = ` (${failedNames.map((name) => baseFailed.has(name) ? `${name}: the base fails it too` : `${name}: the change broke it, the base passes`).join('; ')})`
          }
          if (baseFailed && failedNames.every((name) => baseFailed.has(name))) {
            // Inconclusive: run the failing checks once more, on the change and then on the base, before the verdict holds the Work (sc-13).
            const firstFailed = failed.join('; ')
            const again = await rerunOnChange(failedNames)
            const still = failedNames.filter((name) => again.get(name))
            failed.splice(0, failed.length, ...still.map((name) => again.get(name)!))
            if (!still.length) {
              flaky = verifierRerunReason(failedNames, firstFailed)
            } else {
              const baseAgain = await failingOnBase(still)
              if (!baseAgain || still.every((name) => baseAgain.has(name))) {
                return verdict('inconclusive', `${still.map((name) => `${name}: the base fails it too (base ${base})`).join('; ')}, also on a re-run once; failed on the change: ${firstFailed}; and again: ${failed.join('; ')}`, evidence, 'load')
              }
              return verdict('fail', `failed: ${failed.join('; ')} (the base passed on re-run once; the first run failed on both: ${firstFailed})`, evidence)
            }
          }
        }
      } finally {
        await removeWorktree(tree.repository, worktree)
        rmSync(scratch, { recursive: true, force: true })
      }
      if (checks.name === REPO_CHECKS_V2 && !ran.length) {
        return verdict('inconclusive', `no check ran: every check in ${CHECKS_FILE} is limited by paths the change does not touch`, evidence)
      }
      const which = `run: ${ran.join(', ')}${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}`
      return failed.length
        ? verdict('fail', `failed: ${failed.join('; ')}${baseNote}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`, evidence)
        : verdict('pass', `${flaky}all ${ran.length} check(s) run passed on ${tree.commit}; ${which}`, evidence)
    },
  }
}
