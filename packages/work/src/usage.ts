/**
 * usage-1: the usage outcome of an attempt, recorded with it. `known`: tokens and cost; `partial`: tokens but no cost or no cache
 * split (the reason says which); `unavailable`: nothing, with the reason. `origin` is where the counts were read: the Runtime's
 * stream events, its transcript, or none. Unknown usage is never counted as zero; the report counts each outcome per Runtime.
 */
import type { UsageObserved, WorkEvent, WorkRecord } from './record.ts'

export type Usage = Extract<WorkEvent, { type: 'observed' }>['usage']
type UsageOutcome = NonNullable<Usage['outcome']>
interface UsageReading { outcome: UsageOutcome; reason?: string; origin: NonNullable<Usage['origin']> }
export type CostCoverage = Record<string, Record<UsageOutcome, number>>

/** The usage record of an attempt from what its Worker reported, with the outcome, reason and origin System derives. */
export function usageRecord(usage: Omit<UsageObserved, 'state'> | undefined, gap?: string): Usage {
  if (!usage) return { state: 'unknown', outcome: 'unavailable', reason: gap ?? 'the Worker reported no usage', origin: 'none' }
  const reason = usage.costUsd === undefined ? 'the Runtime reported no cost' : usage.cacheReadTokens === undefined ? 'the Runtime did not split cache use' : undefined
  return { state: 'observed', ...usage, outcome: reason ? 'partial' : 'known', ...(reason ? { reason } : {}), origin: 'stream' }
}

/** The outcome of a recorded usage; a record written before the outcome existed is derived from what it holds. */
export function usageOutcome(usage: Usage): UsageReading {
  if (usage.outcome && usage.origin) return { outcome: usage.outcome, ...(usage.reason ? { reason: usage.reason } : {}), origin: usage.origin }
  if (usage.state === 'unknown') return { outcome: 'unavailable', reason: 'not recorded', origin: 'none' }
  const { outcome, reason, origin } = usageRecord(usage)
  return { outcome: outcome!, ...(reason ? { reason } : {}), origin: origin! }
}

/** Attempts per Runtime by usage outcome, over the Works' observed events; the Runtime is the one the attempt was dispatched to. */
export function costCoverage(records: readonly WorkRecord[]): CostCoverage {
  const coverage: CostCoverage = {}
  for (const record of records) {
    const runtimes = new Map<string, string>()
    for (const event of record.events) {
      if (event.type === 'dispatched') runtimes.set(event.attemptId, event.selected.split('/')[0]!)
      if (event.type !== 'observed') continue
      const runtime = event.worker?.ref.split('/')[0] ?? runtimes.get(event.attemptId) ?? 'unknown'
      const row = (coverage[runtime] ??= { known: 0, partial: 0, unavailable: 0 })
      row[usageOutcome(event.usage).outcome] += 1
    }
  }
  return coverage
}

/** Cache-read tokens over input tokens, both over the attempts that split their cache use; `unknown` when none did. */
export function cacheReadShare(cacheReadTokens: number, splitInputTokens: number): number | 'unknown' {
  return splitInputTokens === 0 ? 'unknown' : cacheReadTokens / splitInputTokens
}

/** Token totals of a set of attempts. `costUsd` is over the attempts that report a cost and is absent when none does; an attempt without usage is only in `attempts.unavailable`. */
export interface UsageTotals {
  inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; freshInputTokens: number; outputTokens: number
  cacheReadShare: number | 'unknown'
  costUsd?: number
  attempts: Record<UsageOutcome, number>
}
export interface UsageReport { total: UsageTotals; byRuntime: Record<string, UsageTotals>; byAccount: Record<string, UsageTotals>; byDay: Record<string, UsageTotals> }

/** The local calendar date (`YYYY-MM-DD`) of an ISO instant. */
function localDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** sum-1: token totals over the Works' observed events, in total and by Runtime, Account (`runtime/account`) and the local date of the Work's admission. Records are only read. */
export function usageTotals(records: readonly WorkRecord[]): UsageReport {
  interface Acc { t: UsageTotals; split: number }
  const fresh = (): Acc => ({ t: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, freshInputTokens: 0, outputTokens: 0, cacheReadShare: 'unknown', attempts: { known: 0, partial: 0, unavailable: 0 } }, split: 0 })
  const total = fresh()
  const groups = { runtime: new Map<string, Acc>(), account: new Map<string, Acc>(), day: new Map<string, Acc>() }
  const add = (acc: Acc, usage: Usage) => {
    const { t } = acc
    t.attempts[usageOutcome(usage).outcome] += 1
    if (usage.state !== 'observed') return
    t.inputTokens += usage.inputTokens
    t.outputTokens += usage.outputTokens
    if (usage.costUsd !== undefined) t.costUsd = (t.costUsd ?? 0) + usage.costUsd
    if (usage.cacheReadTokens === undefined) return
    const write = usage.cacheWriteTokens ?? 0
    t.cacheReadTokens += usage.cacheReadTokens
    t.cacheWriteTokens += write
    t.freshInputTokens += usage.inputTokens - usage.cacheReadTokens - write
    acc.split += usage.inputTokens
  }
  for (const record of records) {
    const admitted = record.events[0]
    const day = admitted ? localDate(admitted.at) : 'unknown'
    const dispatched = new Map<string, string>()
    for (const event of record.events) {
      if (event.type === 'dispatched') dispatched.set(event.attemptId, event.selected)
      if (event.type !== 'observed') continue
      const selected = dispatched.get(event.attemptId)
      const runtime = event.worker?.ref.split('/')[0] ?? selected?.split('/')[0] ?? 'unknown'
      const account = event.worker?.account ? `${runtime}/${event.worker.account}` : selected ?? runtime
      for (const [map, key] of [[groups.runtime, runtime], [groups.account, account], [groups.day, day]] as const) {
        if (!map.has(key)) map.set(key, fresh())
        add(map.get(key)!, event.usage)
      }
      add(total, event.usage)
    }
  }
  const done = ({ t, split }: Acc): UsageTotals => ({ ...t, cacheReadShare: cacheReadShare(t.cacheReadTokens, split) })
  const out = (map: Map<string, Acc>) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, done(v)]))
  return { total: done(total), byRuntime: out(groups.runtime), byAccount: out(groups.account), byDay: out(groups.day) }
}
