/**
 * One account of one agent CLI as a System Worker (ADR-0004 decisions 4-6,
 * ADR-0005). Each attempt: prepare the workspace, run the CLI headless through
 * a `Spawner` (the DSH subprocess service in production), capture outputs,
 * store a bounded log, clean up. Cancellation aborts the process range with a
 * 30 s grace; whatever the attempt produced is kept as unaccepted partial output.
 * An attempt past its time limit is stopped the same way but fails: nobody cancelled it.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Artifacts } from '@system/artifacts'
import { requestedTier, type Tier, type WorkerPort, type WorkerRequest, type WorkerResult } from '@system/work'
import { quotaFromRateLimitEvent, type QuotaEvent, type QuotaReport } from './quota.ts'
import { claudeInvocation, codexInvocation, parseClaude, parseCodex, progressReader, type Runtime } from './runtimes.ts'
import { capture, cleanup, prepare, prompt } from './workspace.ts'

const GRACE_MS = 30_000
/** After the agent exits, its output is read for this long and its process range is given this long to empty; then both are closed (never waited for: a process it left holding the pipes would hold the attempt). */
export const DRAIN_MS = 5000
/** The wall-clock limit of an attempt when neither the account nor the row sets one. */
export const DEFAULT_ATTEMPT_TIMEOUT_MINUTES = 60
const MAX_LOG_BYTES = 256 * 1024
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
  /** How many attempts of this account run at once (the Host's slots); default 1. */
  maxConcurrentAttempts?: number
  /** `primary` is preferred while its quota is under the ceiling (routing by headroom). */
  priority?: 'primary' | 'secondary'
  /** From this share of a quota window used the account is not chosen (the row's `quotaCeilingPercent`; routing's default is 80). */
  quotaCeilingPercent?: number
  /** The account's cached quota reading; routing reads it and records it with the choice. */
  quota?: () => Promise<QuotaReport>
  /** claude-code: told the quota windows an attempt's `rate_limit_event`s reported (the last of each window); a throwing hook never fails the attempt. */
  onRateLimit?: (events: ReadonlyArray<QuotaEvent>) => void
}

/** The last quota event of each window in a Claude Code stream. */
function rateLimitEvents(stdout: string): QuotaEvent[] {
  const last = new Map<string, QuotaEvent>()
  const observedAt = Date.now()
  for (const line of stdout.split('\n')) {
    if (!line.includes('rate_limit_event')) continue
    try {
      const event = quotaFromRateLimitEvent(JSON.parse(line) as unknown, observedAt)
      if (event) last.set(event.window, event)
    } catch { /* not JSON: not an event */ }
  }
  return [...last.values()]
}

/** Input tokens (cache reads included) and minutes; either may be absent. */
export interface AttemptBudget {
  inputTokens?: number
  minutes?: number
}

const digest = (path: string) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '')

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
    priority: account.priority,
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
  const ws = await prepare(artifacts, request, join(attemptsDir, request.attemptId.replace(/[^a-z0-9-]/gi, '_')))
  try {
    const text = prompt(ws, request)
    let invocation
    let codexAuth: { attempt: string; account: string; before: string } | undefined
    if (account.runtime === 'claude-code') {
      const token = await account.token?.()
      if (!token) return { status: 'failed', outputs: {}, reason: `${account.ref}: its token is not configured (system credentials set)`, executor }
      invocation = claudeInvocation(account.command, ws, text, token, model, request.capabilities.includes('code-write'))
    } else {
      const home = join(ws.root, 'codex-home')
      mkdirSync(home, { mode: 0o700 })
      const source = join(account.codexHome!, 'auth.json')
      if (!existsSync(source)) return { status: 'failed', outputs: {}, reason: `${account.ref}: no auth.json in ${account.codexHome} (codex login --device-auth)`, executor }
      // A fresh CODEX_HOME per attempt holding only auth.json: no memories or history carry over (ADR-0005).
      copyFileSync(source, join(home, 'auth.json'))
      codexAuth = { attempt: join(home, 'auth.json'), account: source, before: digest(source) }
      invocation = codexInvocation(account.command, ws, text, home, model)
    }
    // Remove every host variable the agent was not given (SSH agent, tokens, ...).
    const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]))
    Object.assign(env, invocation.env)
    // The limit stops the agent through the same abort as an operator cancel, so SIGTERM, the grace and SIGKILL are one path.
    const limit = account.attemptTimeoutMinutes ?? DEFAULT_ATTEMPT_TIMEOUT_MINUTES
    const stop = new AbortController()
    const forward = () => stop.abort()
    if (request.signal.aborted) forward()
    request.signal.addEventListener('abort', forward, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; forward() }, limit * 60_000)
    // Over budget is stopped through the same abort, and fails with what was spent.
    const budget = account.attemptBudget
    let overBudget: string | undefined
    const spend = (what: string) => { overBudget ??= what; forward() }
    const budgetTimer = budget?.minutes === undefined ? undefined : setTimeout(() => spend(`${budget.minutes} minutes`), budget.minutes * 60_000)
    const spawned = spawner.spawn({ argv: invocation.argv, cwd: ws.work, env, signal: stop.signal, graceMs, drainMs, pidFile: pidFile(attemptsDir, request.attemptId) })
    // Output that grew is activity: what it says so far is the attempt's progress.
    const read = progressReader(account.runtime)
    let seen = 0
    const watch = setInterval(() => {
      const out = spawned.stdout()
      if (out.length === seen) return
      seen = out.length
      const progress = read(out)
      request.progress?.(progress)
      if (budget?.inputTokens !== undefined && (progress.inputTokens ?? 0) > budget.inputTokens) spend(`input tokens (${progress.inputTokens} of ${budget.inputTokens})`)
    }, PROGRESS_MS)
    watch.unref()
    const outcome = await spawned.done.finally(() => {
      clearInterval(watch)
      clearTimeout(timer)
      clearTimeout(budgetTimer)
      request.signal.removeEventListener('abort', forward)
      rmSync(pidFile(attemptsDir, request.attemptId), { force: true })
    })
    const stdout = spawned.stdout()
    // Even a rejected or stopped attempt tells the truth about quota.
    if (account.runtime === 'claude-code' && account.onRateLimit) {
      const events = rateLimitEvents(stdout)
      if (events.length) try { account.onRateLimit(events) } catch { /* a bad hook cannot fail the attempt */ }
    }
    const parsed = account.runtime === 'claude-code' ? parseClaude(stdout) : parseCodex(stdout)
    if (codexAuth) keepRefreshedAuth(codexAuth)
    if (parsed.servedModels?.length) executor.servedModels = parsed.servedModels
    const log = (await artifacts.putBytes({
      kind: 'file', schemaVersion: 1, data: Buffer.from(stdout.slice(-MAX_LOG_BYTES)),
      mediaType: 'application/x-ndjson',
      classification: 'local-private', producer: { type: 'worker', ref: account.ref }, workId: request.workId, attemptId: request.attemptId,
    })).id
    const captured = await capture(artifacts, ws, request, account.ref)
    const common = { log, usage: parsed.usage, executor }
    // A stopped agent's output is incomplete, so its usage is unknown rather than a partial count.
    if (request.signal.aborted) return { status: 'cancelled', outputs: {}, partial: captured.outputs, reason: 'cancelled; the agent was stopped', log, executor }
    if (overBudget) return { status: 'failed', outputs: {}, partial: captured.outputs, reason: `over budget: ${overBudget}`, log, executor }
    if (timedOut) return { status: 'failed', outputs: {}, partial: captured.outputs, reason: `attempt exceeded its time limit of ${limit} minutes`, log, executor }
    if (outcome.exitCode !== 0 || !parsed.ok) {
      const why = outcome.signal ? `signal ${outcome.signal}` : `exit ${outcome.exitCode}`
      return { status: 'failed', outputs: {}, partial: captured.outputs, reason: `${account.ref} ${why}: ${(parsed.message || spawned.stderr()).slice(0, 500)}`, ...common }
    }
    if (captured.missing.length) {
      return { status: 'failed', outputs: {}, partial: captured.outputs, reason: `${account.ref} wrote no output file for ${captured.missing.join(', ')}`, ...common }
    }
    return { status: 'succeeded', outputs: captured.outputs, ...(parsed.message ? { message: parsed.message } : {}), ...common }
  } finally {
    await cleanup(ws)
  }
}

/** Copy a refreshed `auth.json` back, unless the account's file changed meanwhile. */
function keepRefreshedAuth(auth: { attempt: string; account: string; before: string }): void {
  if (!existsSync(auth.attempt) || digest(auth.attempt) === auth.before || digest(auth.account) !== auth.before) return
  const staged = join(dirname(auth.account), `.auth.json.${process.pid}`)
  copyFileSync(auth.attempt, staged)
  renameSync(staged, auth.account)
}
