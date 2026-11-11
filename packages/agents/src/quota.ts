/**
 * Quota readers: how much of an account's 5-hour and weekly window is used, and when each resets.
 *
 * An owner-approved selective port from System 1 (`/home/tan/workspaces/system-agents`, commit
 * `15e2bd5`), from two files only:
 * - `packages/plugins/runtime-claude-agent-sdk/src/limits.ts`: Claude Code's `get_usage` control request;
 * - `packages/plugins/runtime-codex-sdk/src/rate-limits.ts`: `codex app-server`'s `account/rateLimits/read`.
 * System 1's ledger, pools, reservations and per-model windows are not ported.
 *
 * Neither reader runs a model turn. An answer is readable or `unreadable` as a whole: one malformed
 * entry, an unknown CLI version or an answer nobody checked is never a guess.
 *
 * Versions (checked 2026-11-10 from the installed binaries, no account used; see the README): System 1's
 * 2.1.308-2.1.310 and 0.164.0 are not carried over, because this host cannot check them.
 * - Claude Code 2.1.322: `get_usage` takes `{ subtype, skip_behaviors? }` and answers
 *   `{ rate_limits_available: boolean, rate_limits: { five_hour, seven_day, ... } }`, each window
 *   `{ utilization: number | null (0-100), resets_at: ISO 8601 | null }`; `rate_limit_event.rate_limit_info`
 *   has `status`, `resetsAt` (Unix seconds), `rateLimitType` and `utilization` (a fraction).
 * - Codex 0.166.0: `RateLimitWindow = { usedPercent, windowDurationMins | null, resetsAt | null }` (Unix
 *   seconds) in `GetAccountRateLimitsResponse.rateLimits.{primary, secondary}`; `InitializeParams.capabilities`
 *   is nullable.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

export interface QuotaWindow {
  /** 0 to 100. */
  percentUsed: number
  /** ISO time; absent when the reset is not believed. */
  resetsAt?: string
}
export type QuotaWindowName = 'five_hour' | 'seven_day'
export type QuotaReport =
  | { observedAt: string; windows: { five_hour?: QuotaWindow; seven_day?: QuotaWindow } }
  | { unreadable: string }

/** One window as a `rate_limit_event` of an attempt tells it. */
export interface QuotaEvent extends QuotaWindow {
  window: QuotaWindowName
}

export const VERIFIED_CLAUDE_VERSIONS: readonly string[] = ['2.1.322']
export const VERIFIED_CODEX_VERSIONS: readonly string[] = ['0.166.0']

/** A reset time further than this from the reading is not believed (System 1's PLAUSIBLE_MS). */
const PLAUSIBLE_MS = 400 * 86_400_000
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
/** Above this a Unix time is in milliseconds, not seconds. */
const SECONDS_LIMIT = 1e11
const MAX_LINE = 1 << 20
const DEFAULT_TIMEOUT_MS = 30_000
const VERSION_TIMEOUT_MS = 10_000
const KILL_MS = 2000

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const round2 = (n: number) => Math.round(n * 100) / 100
const isShare = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100

/** The reset as an ISO time when it is believed; dropped (undefined) when already past at 100% or too far from `observedAt`. */
function believedReset(reset: number, percentUsed: number, observedAt: number): string | undefined {
  if (!Number.isFinite(reset)) return undefined
  if (percentUsed >= 100 && reset <= observedAt) return undefined
  if (Math.abs(reset - observedAt) > PLAUSIBLE_MS) return undefined
  return new Date(reset).toISOString()
}
function windowOf(percentUsed: number, reset: number | undefined, observedAt: number): QuotaWindow {
  const percent = round2(percentUsed)
  const resetsAt = reset === undefined ? undefined : believedReset(reset, percent, observedAt)
  return { percentUsed: percent, ...(resetsAt ? { resetsAt } : {}) }
}
const report = (windows: Partial<Record<QuotaWindowName, QuotaWindow>>, observedAt: number): QuotaReport =>
  Object.keys(windows).length === 0 ? { unreadable: 'it reports neither five_hour nor seven_day' } : { observedAt: new Date(observedAt).toISOString(), windows }

/** Claude Code's `get_usage` answer. Only `five_hour` and `seven_day` are read; every other entry is ignored unvalidated. */
export function quotaFromUsage(answer: unknown, observedAt: number): QuotaReport {
  if (!isRecord(answer)) return { unreadable: 'its get_usage answer is not an object' }
  if (typeof answer.rate_limits_available !== 'boolean') return { unreadable: 'its get_usage answer is not in the checked shape (no rate_limits_available)' }
  if (!answer.rate_limits_available) return { unreadable: 'no plan limits: API key, third-party provider or no profile scope' }
  const limits = answer.rate_limits
  if (!isRecord(limits)) return { unreadable: 'it reports plan limits, and its rate_limits is not an object' }
  const windows: Partial<Record<QuotaWindowName, QuotaWindow>> = {}
  for (const name of ['five_hour', 'seven_day'] as const) {
    const entry = limits[name]
    if (entry === null || entry === undefined) continue
    if (!isRecord(entry)) return { unreadable: `its ${name} window is not an object` }
    const { utilization, resets_at: resetsAt } = entry
    if (utilization !== null && !isShare(utilization)) return { unreadable: `its ${name} utilization is not a percentage from 0 to 100` }
    let reset: number | undefined
    if (resetsAt !== null) {
      if (typeof resetsAt !== 'string' || !ISO.test(resetsAt) || !Number.isFinite(Date.parse(resetsAt))) return { unreadable: `its ${name} resets_at is not an ISO 8601 time` }
      reset = Date.parse(resetsAt)
    }
    if (utilization === null) continue
    windows[name] = windowOf(utilization, reset, observedAt)
  }
  return report(windows, observedAt)
}

/** Codex's `account/rateLimits/read` result. A window is told by its length (300 or 10080 minutes), never by `primary`/`secondary`. */
export function quotaFromRateLimits(result: unknown, observedAt: number): QuotaReport {
  if (!isRecord(result) || !isRecord(result.rateLimits)) return { unreadable: 'its answer holds no rateLimits object' }
  const snapshot = result.rateLimits
  const windows: Partial<Record<QuotaWindowName, QuotaWindow>> = {}
  for (const slot of ['primary', 'secondary'] as const) {
    const entry = snapshot[slot]
    if (entry === null || entry === undefined) continue
    if (!isRecord(entry)) return { unreadable: `its ${slot} window is not an object` }
    const { usedPercent, windowDurationMins: minutes, resetsAt } = entry
    if (!isShare(usedPercent)) return { unreadable: `its ${slot} usedPercent is not a percentage from 0 to 100` }
    if (minutes !== null && !(typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0)) return { unreadable: `its ${slot} windowDurationMins is not a positive whole number or null` }
    if (resetsAt !== null && !(typeof resetsAt === 'number' && Number.isFinite(resetsAt) && Math.abs(resetsAt) <= SECONDS_LIMIT)) return { unreadable: `its ${slot} resetsAt is not Unix seconds or null` }
    const name: QuotaWindowName | undefined = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day' : undefined
    if (!name) continue
    if (windows[name]) return { unreadable: `two windows are ${minutes} minutes long` }
    windows[name] = windowOf(usedPercent, resetsAt === null ? undefined : resetsAt * 1000, observedAt)
  }
  if (Object.keys(windows).length === 0) return { unreadable: 'it reports no window of 300 or 10080 minutes' }
  return report(windows, observedAt)
}

/**
 * A Claude Code stream line `{ type: 'rate_limit_event', rate_limit_info }` as one window. In 2.1.322
 * `utilization` is a fraction and `resetsAt` Unix seconds; a share outside [0, 1] is never misread.
 */
export function quotaFromRateLimitEvent(event: unknown, observedAt: number): QuotaEvent | undefined {
  if (!isRecord(event) || event.type !== 'rate_limit_event' || !isRecord(event.rate_limit_info)) return undefined
  const info = event.rate_limit_info
  const window = info.rateLimitType
  if (window !== 'five_hour' && window !== 'seven_day') return undefined
  const { utilization, resetsAt, status } = info
  let percent: number
  if (typeof utilization === 'number' && Number.isFinite(utilization) && utilization >= 0 && utilization <= 1) percent = utilization * 100
  else if (status === 'rejected' && (utilization === undefined || utilization === null)) percent = 100
  else return undefined
  const reset = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && Math.abs(resetsAt) <= SECONDS_LIMIT ? resetsAt * 1000 : undefined
  return { window, ...windowOf(percent, reset, observedAt) }
}

// ---- readers ----------------------------------------------------------------------------------

/** The host variables an account's reader keeps; credentials come only from the account. */
const KEEP = ['PATH', 'LANG', 'LC_ALL', 'TZ']
function env(own: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...own }
  for (const key of KEEP) if (process.env[key]) out[key] = process.env[key]!
  return out
}

export interface ReadOptions {
  command: string
  signal?: AbortSignal
  /** Default 30 s. */
  timeoutMs?: number
  /** The clock for `observedAt`, in milliseconds. */
  now?: () => number
}

type Outcome = { value: unknown } | { fail: string }

interface ExchangeOptions {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  start: Record<string, unknown>[]
  /** Called for each JSON object line; returns the outcome once the answer has come. */
  onMessage(message: Record<string, unknown>, send: (message: Record<string, unknown>) => void): Outcome | undefined
  signal?: AbortSignal
  timeoutMs: number
}

/** Run `command args`, send `start`, read JSON lines until `onMessage` answers. Never throws; the process group is always ended. */
function exchange(options: ExchangeOptions): Promise<Outcome> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (error) {
      resolve({ fail: `it could not be started: ${String((error as Error).message).slice(0, 200)}` })
      return
    }
    let settled = false
    let buffered = ''
    const group = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal) } catch { /* already gone */ } }
    const send = (message: Record<string, unknown>) => { child.stdin?.write(`${JSON.stringify(message)}\n`) }
    const finish = (outcome: Outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', stopped)
      child.stdin?.end()
      group('SIGTERM')
      const killer = setTimeout(() => group('SIGKILL'), KILL_MS)
      killer.unref()
      child.once('close', () => clearTimeout(killer))
      resolve(outcome)
    }
    const stopped = () => finish({ fail: 'the read was stopped' })
    const timer = setTimeout(() => finish({ fail: `the read timed out after ${options.timeoutMs} ms` }), options.timeoutMs)
    child.stdin?.on('error', () => undefined)
    child.once('error', (error) => finish({ fail: `it could not be started: ${error.message.slice(0, 200)}` }))
    child.once('close', (code, signal) => finish({ fail: `its output ended before it answered (exit ${code ?? signal ?? 'unknown'})` }))
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffered += chunk.toString()
      let end = buffered.indexOf('\n')
      while (end >= 0 && !settled) {
        const line = buffered.slice(0, end).trim()
        buffered = buffered.slice(end + 1)
        end = buffered.indexOf('\n')
        if (!line) continue
        let message: unknown
        try { message = JSON.parse(line) } catch { finish({ fail: 'it wrote a line that is not JSON' }); return }
        if (!isRecord(message)) { finish({ fail: 'it wrote a line that is not a JSON object' }); return }
        const outcome = options.onMessage(message, send)
        if (outcome) { finish(outcome); return }
      }
      if (buffered.length > MAX_LINE) finish({ fail: `it wrote a line longer than ${MAX_LINE} bytes` })
    })
    if (options.signal?.aborted) { stopped(); return }
    options.signal?.addEventListener('abort', stopped, { once: true })
    for (const message of options.start) send(message)
  })
}

/** `<command> --version` as its bare version, or why it is not one. Nothing but `--version` is spawned. */
async function versionOf(command: string, cwd: string, own: Record<string, string>, pattern: RegExp, signal?: AbortSignal): Promise<{ version: string } | { raw: string }> {
  return new Promise((resolve) => {
    let out = ''
    let child: ChildProcess
    try {
      child = spawn(command, ['--version'], { cwd, env: env(own), detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (error) {
      resolve({ raw: `could not run: ${String((error as Error).message).slice(0, 100)}` })
      return
    }
    let done = false
    const finish = (value: { version: string } | { raw: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
      resolve(value)
    }
    const abort = () => finish({ raw: 'stopped' })
    const timer = setTimeout(() => finish({ raw: 'timed out' }), VERSION_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer | string) => { if (out.length < 4096) out += chunk.toString() })
    child.once('error', (error) => finish({ raw: `could not run: ${error.message.slice(0, 100)}` }))
    child.once('close', () => {
      const first = out.trim().split('\n')[0] ?? ''
      const match = pattern.exec(first)
      finish(match?.[1] ? { version: match[1] } : { raw: first.slice(0, 60) })
    })
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/** The gate: undefined when the version is verified, else the reason the report is unreadable. */
async function gate(label: string, command: string, cwd: string, pattern: RegExp, verified: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  const found = await versionOf(command, cwd, {}, pattern, signal)
  if ('version' in found && verified.includes(found.version)) return undefined
  const what = 'version' in found ? found.version : `(version unreadable: "${found.raw}")`
  return `the usage report of ${label} ${what} is not verified (verified: ${verified.join(', ')})`
}

export interface ClaudeQuotaOptions extends ReadOptions {
  /** The account's `claudeHome`, passed as HOME. */
  home: string
  /** The account's own token. */
  token: string
}

/** Claude Code's `get_usage` control request over stream-json, with the account's own token and HOME, and no model turn. */
export async function readClaudeQuota(options: ClaudeQuotaOptions): Promise<QuotaReport> {
  try {
    // A missing cwd makes spawn fail with the CLI's own ENOENT; name the directory instead of blaming the CLI.
    if (!existsSync(options.home)) return { unreadable: `its claudeHome ${options.home} does not exist and could not be created` }
    const refused = await gate('Claude Code', options.command, options.home, /^(\d+\.\d+\.\d+) \(Claude Code\)$/, VERIFIED_CLAUDE_VERSIONS, options.signal)
    if (refused) return { unreadable: refused }
    const id = randomUUID()
    const now = options.now ?? Date.now
    const outcome = await exchange({
      command: options.command,
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'],
      env: env({ HOME: options.home, TMPDIR: options.home, CLAUDE_CODE_OAUTH_TOKEN: options.token }),
      cwd: options.home,
      start: [{ type: 'control_request', request_id: id, request: { subtype: 'get_usage', skip_behaviors: true } }],
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onMessage(message) {
        if (message.type !== 'control_response' || !isRecord(message.response) || message.response.request_id !== id) return undefined
        const response = message.response
        if (response.subtype === 'success') return { value: response.response }
        if (response.subtype === 'error') return { fail: `get_usage failed: ${String(response.error).slice(0, 200)}` }
        return { fail: 'get_usage answered in an unknown shape' }
      },
    })
    return 'fail' in outcome ? { unreadable: outcome.fail } : quotaFromUsage(outcome.value, now())
  } catch (error) {
    return { unreadable: `the read failed: ${String((error as Error).message).slice(0, 200)}` }
  }
}

export interface CodexQuotaOptions extends ReadOptions {
  /** The account's CODEX_HOME. */
  codexHome: string
}

/** `codex app-server`: `initialize`, then `account/rateLimits/read`, with the account's CODEX_HOME. */
export async function readCodexQuota(options: CodexQuotaOptions): Promise<QuotaReport> {
  try {
    const refused = await gate('Codex', options.command, options.codexHome, /^codex-cli (\d+\.\d+\.\d+)$/, VERIFIED_CODEX_VERSIONS, options.signal)
    if (refused) return { unreadable: refused }
    const now = options.now ?? Date.now
    const outcome = await exchange({
      command: options.command,
      args: ['app-server'],
      env: env({ CODEX_HOME: options.codexHome, HOME: options.codexHome }),
      cwd: options.codexHome,
      start: [{ method: 'initialize', id: 1, params: { clientInfo: { name: 'system', title: 'system agents quota', version: '0' }, capabilities: null } }],
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onMessage(message, send) {
        // The server's own requests and notifications are not answered.
        if (message.id === undefined || message.method !== undefined) return undefined
        if (message.error !== undefined) {
          const said = isRecord(message.error) && typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error)
          return { fail: `the app server refused ${message.id === 1 ? 'initialize' : 'account/rateLimits/read'}: ${said.slice(0, 200)}` }
        }
        if (message.id === 1) {
          send({ method: 'initialized' })
          send({ method: 'account/rateLimits/read', id: 2 })
        } else if (message.id === 2) return { value: message.result }
        return undefined
      },
    })
    return 'fail' in outcome ? { unreadable: outcome.fail } : quotaFromRateLimits(outcome.value, now())
  } catch (error) {
    return { unreadable: `the read failed: ${String((error as Error).message).slice(0, 200)}` }
  }
}

// ---- cache ------------------------------------------------------------------------------------

export interface QuotaCache {
  get(): Promise<QuotaReport>
  /** Merge the windows an attempt's `rate_limit_event`s told; the expiry is not extended. */
  observe(events: ReadonlyArray<QuotaEvent>): void
}

export function createQuotaCache({ read, ttlMs = 600_000, now = Date.now }: { read: () => Promise<QuotaReport>; ttlMs?: number; now?: () => number }): QuotaCache {
  let cached: { report: QuotaReport; expiresAt: number } | undefined
  let pending: Promise<QuotaReport> | undefined
  return {
    get() {
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached.report)
      pending ??= read().then((report) => {
        cached = { report, expiresAt: now() + ttlMs }
        return report
      }).finally(() => { pending = undefined })
      return pending
    },
    observe(events) {
      if (events.length === 0) return
      const current = cached && 'windows' in cached.report ? cached.report.windows : {}
      const windows: { five_hour?: QuotaWindow; seven_day?: QuotaWindow } = { ...current }
      for (const { window, percentUsed, resetsAt } of events) windows[window] = { percentUsed, ...(resetsAt ? { resetsAt } : {}) }
      cached = { report: { observedAt: new Date(now()).toISOString(), windows }, expiresAt: cached ? cached.expiresAt : now() + ttlMs }
    },
  }
}
