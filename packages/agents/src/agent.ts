/**
 * One account of one agent CLI as a System Worker (ADR-0004 decisions 4-6,
 * ADR-0005). Each attempt: prepare the workspace, run the CLI headless through
 * a `Spawner` (the DSH subprocess service in production), capture outputs,
 * store a bounded log, clean up. Cancellation aborts the process range with a
 * 30 s grace; whatever the attempt produced is kept as unaccepted partial output.
 * An attempt past its time limit is stopped the same way but fails: nobody cancelled it.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Artifacts } from '@system/artifacts'
import { requestedTier, writesRepository, type Tier, type WorkerPort, type WorkerRequest, type WorkerResult } from '@system/work'
import { adapterFor } from './adapters/index.ts'
import { realHost, sandboxed, type SandboxHost, type SandboxOption } from './adapters/sandbox.ts'
import type { QuotaEvent, QuotaReport } from './quota.ts'
import type { Runtime } from './runtimes.ts'
import { runAttempt } from './lifecycle.ts'
import { prompt } from './workspace.ts'

const GRACE_MS = 30_000
/** After the agent exits, its output is read for this long and its process range is given this long to empty; then both are closed (never waited for: a process it left holding the pipes would hold the attempt). */
export const DRAIN_MS = 5000
/** How often a running agent's stdout is read for its progress. */
const PROGRESS_MS = 500

interface SpawnSpec {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  signal: AbortSignal
  graceMs: number
  /** After the process exits: how long its output may still be read and its group may still empty before the pipes are closed and what is left is killed (default `DRAIN_MS`). */
  drainMs?: number
  /** Where the process writes its own ID before it starts the CLI (see `recordingPid`), for a later Host to find. */
  pidFile?: string
}

/**
 * The command a spawner runs for `spec`: the CLI itself, started by a shell that first writes its identity to `spec.pidFile`
 * (see `readIdentity`): its process ID and its own `/proc/<pid>/stat` after the command name. `exec` keeps the process, so the
 * identity is the CLI's; the shell's own `PWD` is not passed on.
 */
export function recordingPid(spec: SpawnSpec): string[] {
  return spec.pidFile
    ? ['/bin/sh', '-c', 'echo "$$ $(sed \'s/^.*) //\' /proc/$$/stat 2>/dev/null)" > "$1.tmp" && mv "$1.tmp" "$1" && shift && unset PWD && exec "$@"', 'sh', spec.pidFile, ...spec.argv]
    : spec.argv
}

interface Spawned {
  done: Promise<{ exitCode: number | null; signal: string | null }>
  stdout(): string
  stderr(): string
}

export interface Spawner {
  spawn(spec: SpawnSpec): Spawned
}

export interface Account {
  ref: string
  runtime: Runtime
  capabilities: string[]
  /** Absolute path of the CLI. */
  command: string
  /** Its `--version` output, asked when first needed. */
  version: () => Promise<string>
  /** claude-code: resolves the credential named by the account's tokenRef. */
  token?: () => Promise<string | undefined>
  /** codex: the account's System-owned CODEX_HOME holding `auth.json`. */
  codexHome?: string
  /** antigravity: the Account's System-owned HOME, holding `.gemini/antigravity-cli` (its login, and the permission rules System writes). */
  agyHome?: string
  /** antigravity: the model group the Account draws on, which its quota reads. */
  quotaGroup?: 'gemini' | '3p'
  /** The model to run for each offered tier; a step with no tier gets `standard`, else the CLI's default. */
  models?: Partial<Record<Tier, string>>
  /** Wall-clock limit of one attempt, in minutes (fractions allowed). */
  attemptTimeoutMinutes?: number
  /** What one attempt may spend before it is stopped and fails "over budget" (PROP-0007 decision 2). */
  attemptBudget?: AttemptBudget
  /** Off by default: run the Runtime's process inside the bubblewrap layer (adapters/sandbox.ts, ADR-0016). */
  sandbox?: SandboxOption
  /** How many attempts of this account run at once (the Host's slots); default 1. */
  maxConcurrentAttempts?: number
  /** From this share of a quota window used the account is not chosen (the row's `quotaCeilingPercent`; routing's default is 80). */
  quotaCeilingPercent?: number
  /** The account's cached quota reading; routing reads it and records it with the choice. */
  quota?: (fresh?: boolean) => Promise<QuotaReport>
  /** Runtimes that report quota windows: told the ones an attempt's `rate_limit_event`s reported (the last of each window); a throwing hook never fails the attempt. */
  onRateLimit?: (events: ReadonlyArray<QuotaEvent>) => void
}

/** Input tokens (cache reads included) and minutes; either may be absent. */
export interface AttemptBudget {
  inputTokens?: number
  minutes?: number
}

/** Where the CLI's process ID is kept while an attempt runs, so a later Host can tell whether it is gone. */
const pidFile = (attemptsDir: string, attemptId: string) => join(attemptsDir, `${attemptId.replace(/[^a-z0-9-]/gi, '_')}.pid`)

/** The identity a pid file records: undefined when it has no pid; `pgid` and `start` are absent when the shell could not read /proc, so it cannot be verified. */
function readIdentity(text: string): { pid: number; pgid?: number; start?: string } | undefined {
  const tokens = text.trim().split(/\s+/)
  const pid = Number(tokens[0])
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  // After the pid come stat fields 3...: field n is tokens[n - 2].
  const pgid = Number(tokens[3])
  const start = tokens[20]
  return Number.isInteger(pgid) && pgid > 0 && start && /^\d+$/.test(start) ? { pid, pgid, start } : { pid }
}

/** The start time of a live process, or undefined when there is none (`'gone'`) or /proc cannot say (`'unknown'`). */
function startOf(pid: number): string | 'gone' | 'unknown' {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    return start && /^\d+$/.test(start) ? start : 'unknown'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unknown'
  }
}

/** Whether a process is gone: no such process, or (with a recorded start time) a different process under the reused ID. Unknown is not gone. */
export function exited(pid: number, start?: string): boolean {
  if (start !== undefined) {
    const now = startOf(pid)
    if (now === 'gone') return true
    if (now !== 'unknown') return now !== start
  }
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** The Host's slots limit how many attempts of an account run at once, so none queues here. */
export function agentWorker(account: Account, artifacts: Artifacts, spawner: Spawner, attemptsDir: string, graceMs = GRACE_MS, drainMs = DRAIN_MS, host: SandboxHost = realHost()): WorkerPort {
  return {
    ref: account.ref,
    capabilities: account.capabilities,
    maxConcurrentAttempts: account.maxConcurrentAttempts,
    quotaCeilingPercent: account.quotaCeilingPercent,
    quota: account.quota,
    run: (request) => attempt(account, artifacts, spawner, attemptsDir, request, graceMs, drainMs, host),
    async gone(attemptId) {
      const file = pidFile(attemptsDir, attemptId)
      if (!existsSync(file)) return true
      const id = readIdentity(readFileSync(file, 'utf8'))
      if (id && !exited(id.pid, id.start)) return false
      rmSync(file, { force: true })
      return true
    },
    async end(attemptId) {
      const file = pidFile(attemptsDir, attemptId)
      if (!existsSync(file)) return false
      const id = readIdentity(readFileSync(file, 'utf8'))
      // Only a process whose start time is recorded and still matches is signalled: a reused ID, or an identity nobody recorded, never is.
      if (!id?.start || !id.pgid || startOf(id.pid) !== id.start) return false
      // The CLI leads its own group (the subprocess service starts it so): end the group, and never a group the CLI does not lead.
      const target = id.pgid === id.pid ? -id.pid : id.pid
      const stopped = async (ms: number) => {
        for (const stop = Date.now() + ms; Date.now() < stop; await new Promise((resolve) => setTimeout(resolve, 20))) if (exited(id.pid, id.start)) return true
        return false
      }
      for (const [signal, wait] of [['SIGTERM', 3000], ['SIGKILL', 5000]] as const) {
        try { process.kill(target, signal) } catch { /* already gone */ }
        if (await stopped(wait)) { rmSync(file, { force: true }); return true }
      }
      return false
    },
  }
}

async function attempt(account: Account, artifacts: Artifacts, spawner: Spawner, attemptsDir: string, request: WorkerRequest, graceMs: number, drainMs: number, host: SandboxHost): Promise<WorkerResult> {
  const tier = requestedTier(request.capabilities)
  const model = tier ? account.models?.[tier] : account.models?.standard
  const executor: NonNullable<WorkerResult['executor']> = {
    ref: account.ref, account: account.ref.split('/').slice(1).join('/') || account.ref, command: account.command, version: await account.version(),
    ...(tier ? { tier } : {}), ...(model ? { model } : {}),
  }
  const adapter = adapterFor(account.runtime)!
  const pre = await adapter.preflight(account)
  if ('failed' in pre) return { status: 'failed', outputs: {}, reason: pre.failed, executor }
  let stdout = () => ''
  const secrets = [await account.token?.()]
  return runAttempt({
    secrets,
    artifacts, ref: account.ref, executor, request, dir: join(attemptsDir, request.attemptId.replace(/[^a-z0-9-]/gi, '_')),
    timeoutMinutes: account.attemptTimeoutMinutes, cancelReason: 'cancelled; the agent was stopped',
    log: () => stdout(),
    turn: async (ctx) => {
      const { ws } = ctx
      const text = prompt(ws, request)
      const staged = pre.stage(ws.root)
      const invocation = adapter.invocation({ command: account.command, ws, prompt: text, model, codeWrite: writesRepository(request.capabilities), env: staged.env, ...(account.sandbox ? { sandbox: account.sandbox } : {}) })
      executor.scope = invocation.scope
      // The layer is part of the spawn: when it cannot start the attempt fails Outside and the Runtime never runs unwrapped (ADR-0016 decision 3).
      const layer = account.sandbox ? sandboxed(invocation.argv, ws, { state: dirname(attemptsDir), command: account.command, env: invocation.env }, host) : undefined
      if (layer && 'failed' in layer) return { failure: layer.failed, cause: 'load' }
      // Remove every host variable the agent was not given (SSH agent, tokens, ...).
      const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]))
      Object.assign(env, invocation.env)
      // Over budget is stopped through the lifecycle's abort, and fails with what was spent.
      const budget = account.attemptBudget
      const budgetTimer = budget?.minutes === undefined ? undefined : setTimeout(() => ctx.stop(`over budget: ${budget.minutes} minutes`), budget.minutes * 60_000)
      const spawned = spawner.spawn({ argv: layer?.argv ?? invocation.argv, cwd: ws.work, env, signal: ctx.signal, graceMs, drainMs, pidFile: pidFile(attemptsDir, request.attemptId) })
      stdout = spawned.stdout
      // Output that grew is activity: what it says so far is the attempt's progress.
      const read = adapter.progress()
      let seen = 0
      const watch = setInterval(() => {
        const out = spawned.stdout()
        if (out.length === seen) return
        seen = out.length
        const progress = read(out)
        request.progress?.(progress)
        if (budget?.inputTokens !== undefined && (progress.inputTokens ?? 0) > budget.inputTokens) ctx.stop(`over budget: input tokens (${progress.inputTokens} of ${budget.inputTokens})`)
      }, PROGRESS_MS)
      watch.unref()
      const done = await spawned.done.finally(() => {
        clearInterval(watch)
        clearTimeout(budgetTimer)
        rmSync(pidFile(attemptsDir, request.attemptId), { force: true })
      })
      const out = spawned.stdout()
      // Even a rejected or stopped attempt tells the truth about quota.
      const events = adapter.rateLimitEvents?.(out)
      if (events?.length && account.onRateLimit) try { account.onRateLimit(events) } catch { /* a bad hook cannot fail the attempt */ }
      const parsed = adapter.parse(out, { ws })
      staged.finish()
      if (parsed.servedModels?.length) executor.servedModels = parsed.servedModels
      const summary = adapter.summarize(out)
      const finalResult = parsed.finalResult ? { finalResult: parsed.finalResult } : {}
      if (done.exitCode !== 0 || !parsed.ok) {
        const why = done.signal ? `signal ${done.signal}` : `exit ${done.exitCode}`
        return { failure: `${account.ref} ${why}: ${(parsed.message || spawned.stderr()).slice(0, 500)}`, ...finalResult, summary, usage: parsed.usage, ...(parsed.usageGap ? { usageGap: parsed.usageGap } : {}) }
      }
      return { ...(parsed.message ? { message: parsed.message } : {}), ...finalResult, summary, usage: parsed.usage, ...(parsed.usageGap ? { usageGap: parsed.usageGap } : {}) }
    },
  })
}
