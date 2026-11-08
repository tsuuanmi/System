/**
 * The per-Account circuit breaker of the `web` Runtime (WW6d, PROP-0005): a durable state in the Account's directory
 * (`state.json`), moved by the outcome of each attempt. A sign-in wall or a challenge quarantines the Account at once and only
 * a recheck (recheck.ts) leads out; a site error or a suspected rate limit cools it down for a while and a success clears
 * that. A failure the Host explains (Chrome did not start, a page timeout under load, anything before the browser reached the
 * Site) never changes it. While not `ready` the Account offers no capability, so routing skips it as it does any unavailable
 * Worker, and `system workers` shows the state and what to do. Each state change is noticed once.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import type { WorkerPort } from '@system/work'

export type HealthState = 'ready' | 'cooling' | 'needs-sign-in' | 'challenged'

export interface HealthRecord {
  schema: 'chatgpt-web-account@1'
  state: HealthState
  /** What moved the Account to this state, in words. */
  reason?: string
  /** When it entered this state (ISO time). */
  since: string
  /** While cooling: when it is eligible again. */
  cooldownUntil?: string
  /** Site errors in a row, cleared by a success; the cooldown grows with it. */
  consecutive: number
  lastSuccess?: string
  /** The last notice given: the state it announced, when, and its text. */
  lastNotice?: { state: HealthState; at: string; text: string }
}

export interface HealthSettings {
  /** Cooldown after the 1st, 2nd... consecutive site error, in seconds; the last one repeats. */
  cooldownSeconds: number[]
  /** The 1-minute load average above which the Host is busy; default twice the CPUs. */
  hostLoad?: number
}

export const HEALTH_DEFAULTS: HealthSettings = { cooldownSeconds: [120, 300] }

/** Whether the Host is too busy for a page timeout to say anything about the Account. */
export const hostBusy = (settings: HealthSettings): boolean => loadavg()[0]! > (settings.hostLoad ?? cpus().length * 2)

/** What an attempt ended with, as far as the Account's state is concerned. */
export interface Failure {
  /** The stage the evidence names as failed. */
  failedStage?: string
  reason: string
  /** Whether the browser got as far as opening the Site (its `open` stage began). */
  reachedSite: boolean
  /** The Host's load was high while the attempt ran. */
  hostBusy?: boolean
}

/**
 * The state a failure puts the Account in, or undefined when it says nothing about the Account: anything before the Site was
 * reached, and a timeout of the Host's opening of a page under load, are the Host's. The words are those of the driver and the
 * Runtime; a challenge is read before a sign-in, whose advice ("system workers login") its message shares.
 */
export function classify(failure: Failure): Exclude<HealthState, 'ready'> | undefined {
  if (!failure.reachedSite || failure.failedStage === 'launch') return undefined
  const reason = failure.reason
  if (/challenge|captcha|cloudflare|verify you are human/i.test(reason)) return 'challenged'
  if (/invalid_state|session ended|signed out|sign-in page|login page|sign-in wall/i.test(reason)) return 'needs-sign-in'
  if (/site error|own error page|rate.?limit|too many requests|\b429\b/i.test(reason)) return 'cooling'
  return undefined
}

const SCHEMA = 'chatgpt-web-account@1'
const STATES: readonly string[] = ['ready', 'cooling', 'needs-sign-in', 'challenged']
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export interface HealthOptions {
  now?: () => number
  /** Where a notice goes: the Host's log. */
  log?: (line: string) => void
  settings?: HealthSettings
}

export class AccountHealth {
  private data: HealthRecord
  private readonly file: string
  private readonly dir: string
  readonly ref: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly settings: HealthSettings

  /** `dir` is the Account's directory; its `state.json` is read here, and a missing, corrupt or foreign one is a ready Account. */
  constructor(dir: string, ref: string, options: HealthOptions = {}) {
    this.dir = dir
    this.ref = ref
    this.file = join(dir, 'state.json')
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => {})
    this.settings = options.settings ?? HEALTH_DEFAULTS
    this.data = this.read() ?? { schema: SCHEMA, state: 'ready', since: new Date(this.now()).toISOString(), consecutive: 0 }
  }

  private read(): HealthRecord | undefined {
    try {
      const found = JSON.parse(readFileSync(this.file, 'utf8')) as HealthRecord
      return found?.schema === SCHEMA && STATES.includes(found.state) && typeof found.since === 'string' && Number.isInteger(found.consecutive) ? found : undefined
    } catch {
      return undefined
    }
  }

  get record(): Readonly<HealthRecord> {
    return this.data
  }

  /** Why the Account is not eligible now, with what to do; undefined when it is. A cooldown that has ended ends here. */
  unavailable(): string | undefined {
    if (this.data.state === 'cooling' && this.now() >= Date.parse(this.data.cooldownUntil!)) this.enter('ready', undefined, 'ready again after its cooldown')
    return this.data.state === 'ready' ? undefined : this.describe()
  }

  private describe(): string {
    const { state, reason, since, cooldownUntil } = this.data
    const when = hhmm(Date.parse(since))
    const login = `run \`system workers login ${this.ref} --remote\`, then \`system workers recheck ${this.ref}\``
    if (state === 'needs-sign-in') return `needs sign-in since ${when}: ${login}`
    if (state === 'challenged') return `challenged since ${when}: pass the check by hand in the viewer: ${login}`
    return `cooling down since ${when} after ${reason}, until ${hhmm(Date.parse(cooldownUntil!))}; it ends by itself`
  }

  /** An attempt succeeded: the site works, so a cooldown and the count of errors end. A quarantine stays: only a recheck leaves it. */
  success(): void {
    const at = new Date(this.now()).toISOString()
    this.unavailable()
    this.data = { ...this.data, consecutive: 0, lastSuccess: at }
    if (this.data.state === 'cooling') this.enter('ready', undefined, 'ready again after a success')
    else this.save()
  }

  /** An attempt failed: the state it leads to, if any. */
  failure(failure: Failure): void {
    const to = classify(failure)
    if (!to) return
    this.unavailable()
    if (to === 'cooling') {
      const consecutive = this.data.consecutive + 1
      const seconds = this.settings.cooldownSeconds[Math.min(consecutive - 1, this.settings.cooldownSeconds.length - 1)] ?? 120
      this.data = { ...this.data, consecutive, cooldownUntil: new Date(this.now() + seconds * 1000).toISOString() }
      // A quarantine is not softened by a cooldown.
      if (this.data.state === 'needs-sign-in' || this.data.state === 'challenged') return this.save()
      this.enter('cooling', /rate.?limit|too many|\b429\b/i.test(failure.reason) ? 'a suspected rate limit' : 'a site error')
    } else {
      this.enter(to, to === 'challenged' ? 'a challenge' : 'a sign-in wall')
    }
  }

  /** The recheck passed: ready, whatever state it was in. */
  recheckPassed(): void {
    this.data = { ...this.data, consecutive: 0 }
    if (this.data.state === 'ready') this.save()
    else this.enter('ready', undefined, 'ready again: the recheck passed')
  }

  /** Move to `state`; a change is noticed once (a log line and `lastNotice`), the same state seen again is not. */
  private enter(state: HealthState, reason: string | undefined, ready?: string): void {
    if (this.data.state === state) return this.save()
    const since = new Date(this.now()).toISOString()
    const { reason: _reason, cooldownUntil, ...rest } = this.data
    this.data = { ...rest, state, since, ...(reason ? { reason } : {}), ...(state === 'cooling' ? { cooldownUntil } : {}) }
    const text = state === 'ready' ? ready! : this.describe()
    this.data.lastNotice = { state, at: since, text }
    this.save()
    this.log(`${this.ref}: ${text}`)
  }

  /** Atomic, owner-only. A disk that cannot be written must not end an attempt: the state stays in memory. */
  private save(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      chmodSync(this.dir, 0o700)
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 })
      renameSync(`${this.file}.tmp`, this.file)
    } catch {
      // Kept in memory.
    }
  }
}

/** `system workers`' reason for an Account that is not ready, if it is not. */
export const unavailableReason = (health: AccountHealth): string | undefined => health.unavailable()

/** The Worker as routing sees it: while its Account is not ready it offers no capability (so it is skipped, and `available()` leaves its capabilities out), and stays registered for a Work that names it. */
export function healthWorker(port: WorkerPort, health: AccountHealth): WorkerPort {
  return Object.create(port, { capabilities: { get: () => (health.unavailable() ? [] : port.capabilities), enumerable: true } }) as WorkerPort
}
