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
 * entry or an answer that does not match the reader's JSON Schema is never a guess. The CLI's version is
 * not a gate (Item q-1): it is probed and kept beside a reading as `cliVersion`, evidence only.
 *
 * Shapes (checked from the installed binaries, no account used; see the README; Codex 0.171.0 answers like 0.166.0):
 * - Claude Code 2.1.322: `get_usage` takes `{ subtype, skip_behaviors? }` and answers
 *   `{ rate_limits_available: boolean, rate_limits: { five_hour, seven_day, ... } }`, each window
 *   `{ utilization: number | null (0-100), resets_at: ISO 8601 | null }`; `rate_limit_event.rate_limit_info`
 *   has `status`, `resetsAt` (Unix seconds), `rateLimitType` and `utilization` (a fraction), and
 *   `unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt,status}` (the same units), which carries both windows.
 * - Codex 0.166.0: `RateLimitWindow = { usedPercent, windowDurationMins | null, resetsAt | null }` (Unix
 *   seconds) in `GetAccountRateLimitsResponse.rateLimits.{primary, secondary}`; `InitializeParams.capabilities`
 *   is nullable.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'

export interface QuotaWindow {
  /** 0 to 100. */
  percentUsed: number
  /** ISO time; absent when the reset is not believed. */
  resetsAt?: string
}
export type QuotaWindowName = 'five_hour' | 'seven_day'
export type QuotaReport =
  | { observedAt: string; windows: { five_hour?: QuotaWindow; seven_day?: QuotaWindow }; source?: 'rate_limit_event'; /** The CLI's version when probed: evidence, never a gate. */ cliVersion?: string }
  | { unreadable: string; /** A `retry-after` the provider gave, in milliseconds: the cache does not read again before it. */ retryAfterMs?: number }

/** Why `get_usage` has no plan limits (a `setup-token` token without the profile scope); the cache falls back to attempt events only for it. */
export const NO_PLAN_LIMITS = 'no plan limits: API key, third-party provider or no profile scope'

/** One window as a `rate_limit_event` of an attempt tells it. */
export interface QuotaEvent extends QuotaWindow {
  window: QuotaWindowName
}

/**
 * One JSON Schema (Draft 2020-12) per reader. An answer is readable when at least one 5-hour or weekly window
 * has a used share and a reset; every other entry is ignored. A window present but malformed is also refused.
 */
const CLAUDE_USAGE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['rate_limits'],
  properties: { rate_limits: { type: 'object', properties: { five_hour: { $ref: '#/$defs/window' }, seven_day: { $ref: '#/$defs/window' } }, anyOf: [{ required: ['five_hour'], properties: { five_hour: { $ref: '#/$defs/usedWindow' } } }, { required: ['seven_day'], properties: { seven_day: { $ref: '#/$defs/usedWindow' } } }] } },
  $defs: {
    window: { type: ['object', 'null'], properties: { utilization: { type: ['number', 'null'], minimum: 0, maximum: 100 }, resets_at: { type: ['string', 'null'] } } },
    usedWindow: { type: 'object', required: ['utilization', 'resets_at'], properties: { utilization: { type: 'number', minimum: 0, maximum: 100 }, resets_at: { type: 'string' } } },
  },
} as const
const CODEX_RATE_LIMITS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['rateLimits'],
  properties: { rateLimits: { type: 'object', properties: { primary: { $ref: '#/$defs/window' }, secondary: { $ref: '#/$defs/window' } }, anyOf: [{ required: ['primary'], properties: { primary: { $ref: '#/$defs/usedWindow' } } }, { required: ['secondary'], properties: { secondary: { $ref: '#/$defs/usedWindow' } } }] } },
  $defs: {
    window: { type: ['object', 'null'], properties: { usedPercent: { type: 'number', minimum: 0, maximum: 100 }, windowDurationMins: { type: ['integer', 'null'], minimum: 1 }, resetsAt: { type: ['number', 'null'] } } },
    usedWindow: { type: 'object', required: ['usedPercent', 'windowDurationMins', 'resetsAt'], properties: { usedPercent: { type: 'number', minimum: 0, maximum: 100 }, windowDurationMins: { type: 'integer', enum: [300, 10080] }, resetsAt: { type: 'number' } } },
  },
} as const

/** Antigravity's `/usage` answer: groups of buckets, each a window's remaining share and reset (1.5.18). A malformed bucket anywhere refuses the answer. */
const AGY_USAGE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['command'],
  properties: { command: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['groups'], properties: { groups: { type: 'array', items: { $ref: '#/$defs/group' } } } } } } },
  $defs: {
    group: { type: 'object', required: ['name', 'buckets'], properties: { name: { type: 'string' }, buckets: { type: 'array', items: { $ref: '#/$defs/bucket' } } } },
    bucket: { type: 'object', required: ['window', 'remaining_fraction', 'reset_time'], properties: { window: { type: 'string' }, remaining_fraction: { type: 'number', minimum: 0, maximum: 1 }, reset_time: { type: 'string' } } },
  },
} as const

const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false })
const claudeUsageValid = ajv.compile(CLAUDE_USAGE_SCHEMA)
const codexRateLimitsValid = ajv.compile(CODEX_RATE_LIMITS_SCHEMA)
const agyUsageValid = ajv.compile(AGY_USAGE_SCHEMA)
/** The schema error of an answer, or undefined when it matches. */
function schemaError(validate: ValidateFunction, answer: unknown, label: string): string | undefined {
  if (validate(answer)) return undefined
  return `its ${label} answer does not match the checked schema: ${ajv.errorsText(validate.errors, { dataVar: 'answer' })}`.slice(0, 300)
}

/** A reset time further than this from the reading is not believed (System 1's PLAUSIBLE_MS). */
const PLAUSIBLE_MS = 400 * 86_400_000
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
/** Above this a Unix time is in milliseconds, not seconds. */
const SECONDS_LIMIT = 1e11
const MAX_LINE = 1 << 20
const DEFAULT_TIMEOUT_MS = 30_000
const VERSION_TIMEOUT_MS = 10_000
const KILL_MS = 2000
const CLAUDE_VERSION = /^(\d+\.\d+\.\d+) \(Claude Code\)$/
const CODEX_VERSION = /^codex-cli (\d+\.\d+\.\d+)$/

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
  if (!answer.rate_limits_available) return { unreadable: NO_PLAN_LIMITS }
  const refused = schemaError(claudeUsageValid, answer, 'get_usage')
  if (refused) return { unreadable: refused }
  const limits = answer.rate_limits as Record<string, unknown>
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
  const refused = schemaError(codexRateLimitsValid, result, 'rateLimits')
  if (refused) return { unreadable: refused }
  const snapshot = (result as { rateLimits: Record<string, unknown> }).rateLimits
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

/** The group an Antigravity Account draws on, as its profile names it (`quotaGroup`) and as `/usage` names it. */
export const AGY_GROUPS = { gemini: 'Gemini Models', '3p': 'Claude and GPT models' } as const
export type AgyQuotaGroup = keyof typeof AGY_GROUPS
/** A window not yet started is reported as the Unix epoch: its reset is unknown, not past. */
const EPOCH_RESET = 0

/** Antigravity's `/usage` answer, read for the Account's one group (an Account is one group); used share = 1 - remaining_fraction. */
export function quotaFromAgyUsage(answer: unknown, group: AgyQuotaGroup, observedAt: number): QuotaReport {
  const refused = schemaError(agyUsageValid, answer, 'usage')
  if (refused) return { unreadable: refused }
  const groups = (answer as { command: { data: { groups: Array<{ name: string; buckets: Array<{ window: string; remaining_fraction: number; reset_time: string }> }> } } }).command.data.groups
  const found = groups.filter((g) => g.name === AGY_GROUPS[group])
  if (found.length !== 1) return { unreadable: `its usage answer has ${found.length} groups named "${AGY_GROUPS[group]}", not one` }
  const windows: Partial<Record<QuotaWindowName, QuotaWindow>> = {}
  for (const bucket of found[0]!.buckets) {
    const name: QuotaWindowName | undefined = bucket.window === '5h' ? 'five_hour' : bucket.window === 'weekly' ? 'seven_day' : undefined
    if (!name) continue
    if (windows[name]) return { unreadable: `two ${bucket.window} buckets in "${AGY_GROUPS[group]}"` }
    if (!ISO.test(bucket.reset_time) || !Number.isFinite(Date.parse(bucket.reset_time))) return { unreadable: `its ${bucket.window} reset_time is not an ISO 8601 time` }
    const reset = Date.parse(bucket.reset_time)
    windows[name] = windowOf((1 - bucket.remaining_fraction) * 100, reset === EPOCH_RESET ? undefined : reset, observedAt)
  }
  return report(windows, observedAt)
}

/** One window of a `rate_limit_event`: a fraction in [0, 1], or `rejected` without a share (100%); anything else is skipped. */
function eventWindow(window: QuotaWindowName, entry: Record<string, unknown>, observedAt: number): QuotaEvent | undefined {
  const { utilization, resetsAt, status } = entry
  let percent: number
  if (typeof utilization === 'number' && Number.isFinite(utilization) && utilization >= 0 && utilization <= 1) percent = utilization * 100
  else if (status === 'rejected' && (utilization === undefined || utilization === null)) percent = 100
  else return undefined
  const reset = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && Math.abs(resetsAt) <= SECONDS_LIMIT ? resetsAt * 1000 : undefined
  return { window, ...windowOf(percent, reset, observedAt) }
}

/**
 * A Claude Code stream line `{ type: 'rate_limit_event', rate_limit_info }` as its windows. In 2.1.322
 * `utilization` is a fraction and `resetsAt` Unix seconds; a share outside [0, 1] is never misread.
 * `unifiedWindows.{five_hour,seven_day}` are read first; the top-level fields tell `rateLimitType`'s
 * window only when `unifiedWindows` has no entry for it. One bad window never drops the other.
 */
export function quotaFromRateLimitEvent(event: unknown, observedAt: number): QuotaEvent[] {
  if (!isRecord(event) || event.type !== 'rate_limit_event' || !isRecord(event.rate_limit_info)) return []
  const info = event.rate_limit_info
  const unified = isRecord(info.unifiedWindows) ? info.unifiedWindows : {}
  const out: QuotaEvent[] = []
  for (const name of ['five_hour', 'seven_day'] as const) {
    const entry = unified[name]
    const source = isRecord(entry) ? entry : info.rateLimitType === name ? info : undefined
    const read = source && eventWindow(name, source, observedAt)
    if (read) out.push(read)
  }
  return out
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

type Outcome = { value: unknown } | { fail: string; retryAfterMs?: number }

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

/** The CLI's version as evidence beside a reading, never a gate; only a CLI that cannot be run stops the read. */
async function cliVersionOf(command: string, cwd: string, pattern: RegExp, signal?: AbortSignal): Promise<{ cliVersion?: string; failed?: string }> {
  const found = await versionOf(command, cwd, {}, pattern, signal)
  if ('version' in found) return { cliVersion: found.version }
  return found.raw.startsWith('could not run') ? { failed: `the CLI ${found.raw}` } : {}
}
/** Keep the evidence on a readable report. */
const withVersion = (report: QuotaReport, cliVersion: string | undefined): QuotaReport => cliVersion && 'windows' in report ? { ...report, cliVersion } : report
/** A `retry-after` in seconds from a provider error (a field `retryAfter`, `retry_after` or `retry-after`, or `retry-after: N` in its text), in milliseconds. */
function retryAfterOf(error: unknown): number | undefined {
  const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : undefined
  if (typeof error === 'string') {
    const m = /retry[- _]?after\D{0,3}(\d+(?:\.\d+)?)/i.exec(error)
    return m ? seconds(Number(m[1])) : undefined
  }
  if (!isRecord(error)) return undefined
  for (const holder of [error, isRecord(error.data) ? error.data : {}]) {
    for (const key of ['retryAfter', 'retry_after', 'retry-after']) {
      const found = seconds(holder[key])
      if (found) return found
    }
  }
  return typeof error.message === 'string' ? retryAfterOf(error.message) : undefined
}
const failed = (outcome: { fail: string; retryAfterMs?: number }): QuotaReport => ({ unreadable: outcome.fail, ...(outcome.retryAfterMs ? { retryAfterMs: outcome.retryAfterMs } : {}) })

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
    const { cliVersion, failed: notRun } = await cliVersionOf(options.command, options.home, CLAUDE_VERSION, options.signal)
    if (notRun) return { unreadable: notRun }
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
        if (response.subtype === 'error') return { fail: `get_usage failed: ${String(response.error).slice(0, 200)}`, retryAfterMs: retryAfterOf(response.error) }
        return { fail: 'get_usage answered in an unknown shape' }
      },
    })
    return 'fail' in outcome ? failed(outcome) : withVersion(quotaFromUsage(outcome.value, now()), cliVersion)
  } catch (error) {
    return { unreadable: `the read failed: ${String((error as Error).message).slice(0, 200)}` }
  }
}

export interface ClaudeProbeOptions extends ReadOptions {
  home: string
  token: string
  /** The account's economy-tier model; without one the CLI's default. */
  model?: string
}

/** A probe is a real model turn, so it is given longer than a read. */
const PROBE_TIMEOUT_MS = 60_000

/**
 * The smallest attempt that yields a reading (ss-5): `claude -p` with a one-word prompt at the economy tier, in an
 * empty directory, with the account's own token and HOME. Ends at the first `rate_limit_event` that tells a window.
 * Never throws: a probe that fails or tells nothing is an empty list.
 */
export async function probeClaudeQuota(options: ClaudeProbeOptions): Promise<QuotaEvent[]> {
  let cwd: string | undefined
  try {
    if (!existsSync(options.home)) return []
    cwd = mkdtempSync(join(tmpdir(), 'system-probe-'))
    const now = options.now ?? Date.now
    const outcome = await exchange({
      command: options.command,
      args: ['-p', 'hi', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', ...(options.model ? ['--model', options.model] : [])],
      env: env({ HOME: options.home, TMPDIR: options.home, CLAUDE_CODE_OAUTH_TOKEN: options.token }),
      cwd,
      start: [],
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      onMessage(message) {
        if (message.type !== 'rate_limit_event') return undefined
        const events = quotaFromRateLimitEvent(message, now())
        return events.length ? { value: events } : undefined
      },
    })
    return 'value' in outcome ? outcome.value as QuotaEvent[] : []
  } catch {
    return []
  } finally {
    if (cwd) rmSync(cwd, { recursive: true, force: true })
  }
}

export interface CodexQuotaOptions extends ReadOptions {
  /** The account's CODEX_HOME. */
  codexHome: string
}

/** `codex app-server`: `initialize`, then `account/rateLimits/read`, with the account's CODEX_HOME. */
export async function readCodexQuota(options: CodexQuotaOptions): Promise<QuotaReport> {
  try {
    const { cliVersion, failed: notRun } = await cliVersionOf(options.command, options.codexHome, CODEX_VERSION, options.signal)
    if (notRun) return { unreadable: notRun }
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
          return { fail: `the app server refused ${message.id === 1 ? 'initialize' : 'account/rateLimits/read'}: ${said.slice(0, 200)}`, retryAfterMs: retryAfterOf(message.error) }
        }
        if (message.id === 1) {
          send({ method: 'initialized' })
          send({ method: 'account/rateLimits/read', id: 2 })
        } else if (message.id === 2) return { value: message.result }
        return undefined
      },
    })
    return 'fail' in outcome ? failed(outcome) : withVersion(quotaFromRateLimits(outcome.value, now()), cliVersion)
  } catch (error) {
    return { unreadable: `the read failed: ${String((error as Error).message).slice(0, 200)}` }
  }
}

export interface AntigravityQuotaOptions extends ReadOptions {
  /** The Account's `agyHome`, passed as HOME (the token is read from it by `agy`, never by System). */
  home: string
  group: AgyQuotaGroup
}

/** `agy -p /usage --output-format json` with the Account's HOME and no session bus (so no keyring is asked), and no model turn. */
export async function readAntigravityQuota(options: AntigravityQuotaOptions): Promise<QuotaReport> {
  try {
    if (!existsSync(options.home)) return { unreadable: `its agyHome ${options.home} does not exist` }
    const now = options.now ?? Date.now
    const outcome = await exchange({
      command: options.command,
      args: ['-p', '/usage', '--output-format', 'json', '--print-timeout', '30s'],
      env: env({ HOME: options.home }),
      cwd: options.home,
      start: [],
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onMessage(message) {
        if (message.status === 'ERROR' || message.error !== undefined) {
          const said = typeof message.error === 'string' ? message.error : JSON.stringify(message.error ?? message)
          return { fail: `usage failed: ${said.slice(0, 200)}`, retryAfterMs: retryAfterOf(said) }
        }
        return { value: message }
      },
    })
    return 'fail' in outcome ? failed(outcome) : quotaFromAgyUsage(outcome.value, options.group, now())
  } catch (error) {
    return { unreadable: `the read failed: ${String((error as Error).message).slice(0, 200)}` }
  }
}

// ---- cache ------------------------------------------------------------------------------------

export interface QuotaCache {
  get(): Promise<QuotaReport>
  /** Drop the cached reading; the next `get` reads again. A read in flight still resolves. */
  invalidate(): void
  /** Merge the windows an attempt's `rate_limit_event`s told; the expiry is not extended. */
  observe(events: ReadonlyArray<QuotaEvent>): void
}

export type Observed = { observedAt: number; windows: { five_hour?: QuotaWindow; seven_day?: QuotaWindow } }

/** `seed` is a saved event reading (after a restart); `persist` is handed each new one. */
/** A reading older than this, or none, is probed before a step is dispatched (ss-5). */
export const PROBE_STALE_MS = 30 * 60_000

/** `probe` (claude-code) is the smallest attempt that yields a reading; it runs at most once per 30 minutes, and its events are observed like an attempt's. */
export function createQuotaCache({ read, ttlMs = 600_000, now = Date.now, seed, persist, probe }: { read: () => Promise<QuotaReport>; ttlMs?: number; now?: () => number; seed?: Observed; persist?: (observed: Observed) => void; probe?: () => Promise<QuotaEvent[]> }): QuotaCache {
  let cached: { report: QuotaReport; expiresAt: number } | undefined
  let pending: Promise<QuotaReport> | undefined
  let probedAt: number | undefined
  /** What the attempts' events told last, kept apart from the cached report so it outlives the TTL. */
  let fromEvents: Observed | undefined
  // A saved window whose reset has passed is no longer true (it would keep the account over the ceiling); none left is no reading.
  if (seed) {
    const windows = Object.fromEntries(Object.entries(seed.windows).filter(([, w]) => !w.resetsAt || !(Date.parse(w.resetsAt) <= now())))
    if (Object.keys(windows).length) fromEvents = { observedAt: seed.observedAt, windows }
  }
  const eventReading = (from: Observed): QuotaReport => ({ observedAt: new Date(from.observedAt).toISOString(), windows: { ...from.windows }, source: 'rate_limit_event' })
  // get_usage has no plan limits: an attempt's events are the reading then.
  const noPlanLimits = (report: QuotaReport) => 'unreadable' in report && report.unreadable === NO_PLAN_LIMITS
  /** Fold events into what the attempts told last, and persist it; returns the time. */
  const merge = (events: ReadonlyArray<QuotaEvent>): number => {
    const at = now()
    const own: { five_hour?: QuotaWindow; seven_day?: QuotaWindow } = { ...fromEvents?.windows }
    for (const { window, percentUsed, resetsAt } of events) own[window] = { percentUsed, ...(resetsAt ? { resetsAt } : {}) }
    fromEvents = { observedAt: at, windows: own }
    persist?.(fromEvents)
    return at
  }
  /** Not before the provider's `retry-after`, nor before the reset of a window that is used up: a read cannot tell more earlier. */
  const notBefore = (report: QuotaReport): number => {
    if ('unreadable' in report) return report.retryAfterMs ? now() + report.retryAfterMs : 0
    let until = 0
    for (const w of Object.values(report.windows)) if (w.percentUsed >= 100 && w.resetsAt) until = Math.max(until, Date.parse(w.resetsAt))
    return until
  }
  return {
    get() {
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached.report)
      pending ??= read().then(async (report) => {
        let shown = fromEvents && noPlanLimits(report) ? eventReading(fromEvents) : report
        const missing = 'unreadable' in shown
        const old = 'windows' in shown && shown.source === 'rate_limit_event' && now() - Date.parse(shown.observedAt) > PROBE_STALE_MS
        if (probe && (missing || old) && (probedAt === undefined || now() - probedAt >= PROBE_STALE_MS)) {
          probedAt = now()
          try {
            const events = await probe()
            if (events.length) {
              merge(events)
              shown = eventReading(fromEvents!)
            }
          } catch { /* the Account stays as unreadable as before; a probe never fails a step */ }
        }
        cached = { report: shown, expiresAt: Math.max(now() + ttlMs, notBefore(shown)) }
        return shown
      }).finally(() => { pending = undefined })
      return pending
    },
    invalidate() { cached = undefined },
    observe(events) {
      if (events.length === 0) return
      const at = merge(events)
      if (!cached) return
      if ('windows' in cached.report) {
        const windows: { five_hour?: QuotaWindow; seven_day?: QuotaWindow } = { ...cached.report.windows }
        for (const { window, percentUsed, resetsAt } of events) windows[window] = { percentUsed, ...(resetsAt ? { resetsAt } : {}) }
        cached = { report: { observedAt: new Date(at).toISOString(), windows, ...(cached.report.source ? { source: cached.report.source } : {}), ...(cached.report.cliVersion ? { cliVersion: cached.report.cliVersion } : {}) }, expiresAt: cached.expiresAt }
      } else if (noPlanLimits(cached.report)) cached = { report: eventReading(fromEvents!), expiresAt: cached.expiresAt }
    },
  }
}
