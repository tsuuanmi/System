/**
 * A Work's measurements, derived from its events (mvp.md failure test 8,
 * MVP-06): duration, attempts, time waited for a slot, rate-limited attempts, the operator's touches, and usage. Submitting
 * Work is the request itself, not a touch; a human cancel, retry or decision
 * is. Usage an attempt did not report, or did not split into cache and fresh input, is counted apart, never as zero.
 */
import { outsideCause, type OutsideCause } from './outside.ts'
import type { WorkRecord } from './record.ts'

/** One failed attempt, failed or inconclusive verdict, hold, failed publish or operator touch, read from `event` (`<type>#<index>`); `outside` when its reason is an Outside failure, absent for a failure of the change. */
export interface Failure { event: string; kind: 'attempt' | 'attempt-lost' | 'verdict' | 'hold' | 'publish' | 'touch'; reason: string; outside?: OutsideCause }

export interface WorkSummary {
  id: string
  status: WorkRecord['state']['status']
  durationMs: number
  attempts: number
  /** Time steps waited for a free Account or check slot, summed. */
  waitedForSlotMs: number
  /** Worker attempts that failed on a rate limit. */
  rateLimitedAttempts: number
  operatorTouches: number
  touches: string[]
  /** Every failure and touch with its classification; `outsideFailures + changeFailures === failures.length`. */
  failures: Failure[]
  outsideFailures: number
  changeFailures: number
  /** `inputTokens` is the total; fresh input counts only attempts that split their cache use. */
  usage: {
    inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; freshInputTokens: number; outputTokens: number
    observedAttempts: number; unsplitAttempts: number; unknownAttempts: number
    /** The CLI's client-side API-equivalent cost estimate (not what a subscription is billed), over the attempts that report it, old records' `costUsd` included; absent when none does. */
    costUsdEstimate?: number
  }
}

export function summarize(record: WorkRecord): WorkSummary {
  const touches: string[] = []
  const usage: WorkSummary['usage'] = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, freshInputTokens: 0, outputTokens: 0, observedAttempts: 0, unsplitAttempts: 0, unknownAttempts: 0 }
  let attempts = 0
  let waitedForSlotMs = 0
  let rateLimitedAttempts = 0
  const failures: Failure[] = []
  const add = (index: number, kind: Failure['kind'], reason: string, outside = outsideCause(reason)) => {
    failures.push({ event: `${record.events[index]!.type}#${index}`, kind, reason, ...(outside ? { outside } : {}) })
  }
  const lastOutside = () => failures.at(-1)?.outside
  const lastVerdict = () => failures.findLast((f) => f.kind === 'verdict')
  for (const [index, event] of record.events.entries()) {
    if (event.type === 'observed' && event.status === 'failed') add(index, 'attempt', event.reason ?? '', event.rateLimited ? 'quota' : undefined)
    if (event.type === 'attempt-lost') add(index, 'attempt-lost', event.reason, 'restart')
    if (event.type === 'verified' && (event.verdict === 'fail' || event.verdict === 'inconclusive')) add(index, 'verdict', event.reason)
    if (event.type === 'effect-observed' && event.state === 'failed') add(index, 'publish', event.reason, event.rejected === 'conflict' ? 'conflict' : undefined)
    if (event.type === 'terminal' && event.outcome === 'held' && event.reason !== 'verification passed; awaiting operator approval') {
      add(index, 'hold', event.reason, /^inconclusive verification/.test(event.reason) ? lastVerdict()?.outside : undefined)
    }
    if (event.type === 'dispatched') {
      if (event.executor === 'worker') attempts += 1
      waitedForSlotMs += event.waitedMs ?? 0
    }
    if (event.type === 'observed' && event.rateLimited) rateLimitedAttempts += 1
    if (event.type === 'observed') {
      if (event.usage.state === 'observed') {
        usage.inputTokens += event.usage.inputTokens
        usage.outputTokens += event.usage.outputTokens
        usage.observedAttempts += 1
        if (event.usage.costUsd !== undefined) usage.costUsdEstimate = (usage.costUsdEstimate ?? 0) + event.usage.costUsd
        const { cacheReadTokens, cacheWriteTokens = 0 } = event.usage
        if (cacheReadTokens === undefined) {
          usage.unsplitAttempts += 1
        } else {
          usage.cacheReadTokens += cacheReadTokens
          usage.cacheWriteTokens += cacheWriteTokens
          usage.freshInputTokens += event.usage.inputTokens - cacheReadTokens - cacheWriteTokens
        }
      } else {
        usage.unknownAttempts += 1
      }
    }
    if (event.type === 'terminal' && event.outcome === 'cancelled' && event.caller?.type === 'human') { touches.push('cancel'); add(index, 'touch', event.reason) }
    if (event.type === 'reopened' && event.caller?.type === 'human') { touches.push(`retry ${event.stepId}`); add(index, 'touch', event.reason, lastOutside()) }
    if (event.type === 'decided') { touches.push(`${event.decision} ${event.stepId}`); add(index, 'touch', event.reason, lastOutside()) }
  }
  const first = Date.parse(record.events[0]!.at)
  const last = Date.parse(record.events.at(-1)!.at)
  return { id: record.id, status: record.state.status, durationMs: last - first, attempts, waitedForSlotMs, rateLimitedAttempts, operatorTouches: touches.length, touches, failures, outsideFailures: failures.filter((f) => f.outside).length, changeFailures: failures.filter((f) => !f.outside).length, usage }
}
