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
