/**
 * One account of one agent CLI as a System Worker (ADR-0004 decisions 4-6,
 * ADR-0005). Each attempt: prepare the workspace, run the CLI headless through
 * a `Spawner` (the DSH subprocess service in production), capture outputs,
 * store a bounded log, clean up. Cancellation aborts the process range with a
 * 30 s grace; whatever the attempt produced is kept as unaccepted partial output.
 * An attempt past its time limit is stopped the same way but fails: nobody cancelled it.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Artifacts } from '@system/artifacts'
import { requestedTier, writesRepository, type Tier, type WorkerPort, type WorkerRequest, type WorkerResult } from '@system/work'
import { adapterFor } from './adapters/index.ts'
import type { SandboxOption } from './adapters/sandbox.ts'
import type { QuotaEvent, QuotaReport } from './quota.ts'
import type { Runtime } from './runtimes.ts'
import { runAttempt } from './lifecycle.ts'
import { prompt } from './workspace.ts'

const GRACE_MS = 30_000
/** After the agent exits, its output is read for this long and its process range is given this long to empty; then both are closed (never waited for: a process it left holding the pipes would hold the attempt). */
export const DRAIN_MS = 5000
/** How often a running agent's stdout is read for its progress. */
const PROGRESS_MS = 500

export interface SpawnSpec {
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

/** The command a spawner runs for `spec`: the CLI itself, started by a shell that first writes its process ID (`exec` keeps it, and the shell's own `PWD` is not passed on) to `spec.pidFile`. */
export function recordingPid(spec: SpawnSpec): string[] {
  return spec.pidFile ? ['/bin/sh', '-c', 'echo $$ > "$1" && shift && unset PWD && exec "$@"', 'sh', spec.pidFile, ...spec.argv] : spec.argv
}

export interface Spawned {
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
  /** The model to run for each offered tier; a step with no tier gets `standard`, else the CLI's default. */
  models?: Partial<Record<Tier, string>>
  /** Wall-clock limit of one attempt, in minutes (fractions allowed). */
  attemptTimeoutMinutes?: number
  /** What one attempt may spend before it is stopped and fails "over budget" (PROP-0007 decision 2). */
  attemptBudget?: AttemptBudget
  /** claude-code, a spike, off by default: run the attempt's Bash in Claude Code's sandbox (adapters/sandbox.ts). */
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

/** Whether a process is gone: no such process (a reused ID only ever reads as alive). */
export function exited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** The Host's slots limit how many attempts of an account run at once, so none queues here. */
export function agentWorker(account: Account, artifacts: Artifacts, spawner: Spawner, attemptsDir: string, graceMs = GRACE_MS, drainMs = DRAIN_MS): WorkerPort {
  return {
    ref: account.ref,
    capabilities: account.capabilities,
    maxConcurrentAttempts: account.maxConcurrentAttempts,
    quotaCeilingPercent: account.quotaCeilingPercent,
    quota: account.quota,
    run: (request) => attempt(account, artifacts, spawner, attemptsDir, request, graceMs, drainMs),
    async gone(attemptId) {
      const file = pidFile(attemptsDir, attemptId)
      if (!existsSync(file)) return true
      const pid = Number(readFileSync(file, 'utf8'))
      if (Number.isInteger(pid) && pid > 0 && !exited(pid)) return false
      rmSync(file, { force: true })
      return true
    },
  }
}

async function attempt(account: Account, artifacts: Artifacts, spawner: Spawner, attemptsDir: string, request: WorkerRequest, graceMs: number, drainMs: number): Promise<WorkerResult> {
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
  return runAttempt({
    artifacts, ref: account.ref, executor, request, dir: join(attemptsDir, request.attemptId.replace(/[^a-z0-9-]/gi, '_')),
    timeoutMinutes: account.attemptTimeoutMinutes, cancelReason: 'cancelled; the agent was stopped',
    log: () => stdout(),
    turn: async (ctx) => {
      const { ws } = ctx
      const text = prompt(ws, request)
      const staged = pre.stage(ws.root)
      const invocation = adapter.invocation({ command: account.command, ws, prompt: text, model, codeWrite: writesRepository(request.capabilities), env: staged.env, ...(account.sandbox ? { sandbox: account.sandbox } : {}) })
      // Remove every host variable the agent was not given (SSH agent, tokens, ...).
      const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]))
      Object.assign(env, invocation.env)
      // Over budget is stopped through the lifecycle's abort, and fails with what was spent.
      const budget = account.attemptBudget
      const budgetTimer = budget?.minutes === undefined ? undefined : setTimeout(() => ctx.stop(`over budget: ${budget.minutes} minutes`), budget.minutes * 60_000)
      const spawned = spawner.spawn({ argv: invocation.argv, cwd: ws.work, env, signal: ctx.signal, graceMs, drainMs, pidFile: pidFile(attemptsDir, request.attemptId) })
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
      const parsed = adapter.parse(out)
      staged.finish()
      if (parsed.servedModels?.length) executor.servedModels = parsed.servedModels
      const summary = adapter.summarize(out)
      if (done.exitCode !== 0 || !parsed.ok) {
        const why = done.signal ? `signal ${done.signal}` : `exit ${done.exitCode}`
        return { failure: `${account.ref} ${why}: ${(parsed.message || spawned.stderr()).slice(0, 500)}`, summary, usage: parsed.usage }
      }
      return { ...(parsed.message ? { message: parsed.message } : {}), summary, usage: parsed.usage }
    },
  })
}
