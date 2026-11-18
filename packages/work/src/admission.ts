/**
 * Account admission (PLAN SC): which Account may take a step now, and when to look again. Owns the quota waits and
 * their timers, the Accounts that limited an attempt, and today's attempt counts (kept as attempts are dispatched).
 * In memory only: after a restart the quota is read fresh and routing is as usual.
 */
import { DEFAULT_LIMIT_MS } from './limits.ts'
import type { QuotaReading } from './headroom.ts'
import type { Capabilities, Route, WorkerPort } from './registry.ts'

export interface Clock { now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(timer: unknown): void }
/** Its timers never keep the process alive by themselves. */
const systemClock: Clock = { now: Date.now, setTimer: (fn, ms) => setTimeout(fn, ms).unref(), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout) }
/** A step over the quota Ceiling is routed again at its reset, or at least this often. */
export const QUOTA_RETRY_MS = 5 * 60_000
const DAY_MS = 86_400_000

export interface QuotaWait { workId: string; stepId: string; worker: string; since: number; until?: string }
type Step = { workId: string; stepId: string; key: string }

export class AccountAdmission {
  private wake = () => {}
  private readonly waits = new Map<string, QuotaWait & { timer: unknown }>()
  /** Account -> when its limit ends (ms). */
  private readonly limited = new Map<string, number>()
  /** Attempts since `day` (00:00 UTC) by Account; seeded from `history` on first read, then kept by `count`. */
  private counts: Map<string, number> | undefined
  private day = 0

  private readonly options: { clock?: Clock; retryMs?: number; history?: () => Iterable<{ ref: string; at: number }> }

  constructor(options: AccountAdmission['options'] = {}) { this.options = options }

  private get clock(): Clock { return this.options.clock ?? systemClock }

  /** Call `fn` when a quota wait is over: the step is routed again. */
  onWake(fn: () => void): void { this.wake = fn }

  /** The Account that may take the step now, else `quotaWait` (a wake-up timer is set) or `full`. `readings` are the caller's, for the record. */
  route(capabilities: Capabilities, step: Step, needs: readonly string[], only: string | undefined, free: (worker: WorkerPort) => boolean, readings: ReadonlyMap<string, QuotaReading>, prefer?: string): Route<WorkerPort> {
    const now = this.clock.now()
    for (const [ref, until] of this.limited) if (until <= now) this.limited.delete(ref)
    // A fresh readable reading of an Account is believed over the record of its limit.
    const limited = new Set([...this.limited.keys()].filter((ref) => !('windows' in (readings.get(ref) ?? {}))))
    const route = capabilities.routeWorker(needs, only, free, readings, limited, this.attemptsToday(), prefer)
    const until = route.quotaWait?.resetsAt
    const was = this.waits.get(step.key)
    if (route.quotaWait && (!was || was.until !== until)) {
      this.clock.clearTimer(was?.timer)
      const delay = Math.min(this.options.retryMs ?? QUOTA_RETRY_MS, until ? Math.max(0, Date.parse(until) - now) : Infinity)
      const timer = this.clock.setTimer(() => { this.waits.delete(step.key); this.wake() }, delay)
      this.waits.set(step.key, { ...step, worker: capabilities.rankable(needs, only, free)[0]!.ref, since: was?.since ?? now, ...(until ? { until } : {}), timer })
    }
    return route
  }

  /** The Work's steps waiting on quota. */
  waiting(workId: string): QuotaWait[] { return [...this.waits.values()].filter((w) => w.workId === workId).map(({ timer: _, ...wait }) => wait) }

  /** When the step (`<work>/<step>`) began to wait on quota. */
  waitingSince(key: string): number | undefined { return this.waits.get(key)?.since }

  stop(key: string): void {
    this.clock.clearTimer(this.waits.get(key)?.timer)
    this.waits.delete(key)
  }

  stopWork(workId: string): void {
    for (const [key, wait] of [...this.waits]) if (wait.workId === workId) this.stop(key)
  }

  /** The Account limited an attempt: passed over until `until` (ms), else the default 5 hours. */
  limit(ref: string, until: number = this.clock.now() + DEFAULT_LIMIT_MS): void { this.limited.set(ref, until) }

  /** A Worker attempt was dispatched on the Account; before the first read the seed finds it in the record. */
  count(ref: string): void {
    if (this.counts) this.attemptsToday().set(ref, (this.counts.get(ref) ?? 0) + 1)
  }

  /** Worker attempts dispatched since 00:00 UTC, by Account (limited ones included). */
  attemptsToday(): Map<string, number> {
    const now = this.clock.now()
    if (!this.counts || now >= this.day + DAY_MS) {
      const seeding = !this.counts
      this.day = new Date(now).setUTCHours(0, 0, 0, 0)
      this.counts = new Map()
      if (seeding) for (const { ref, at } of this.options.history?.() ?? []) if (at >= this.day) this.counts.set(ref, (this.counts.get(ref) ?? 0) + 1)
    }
    return this.counts
  }
}
