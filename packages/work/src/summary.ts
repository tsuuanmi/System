/**
 * A Work's measurements, derived from its events (operator touches,
 * MVP-06): duration, attempts, time waited for a slot, rate-limited attempts, the operator's touches, and usage. Submitting
 * Work is the request itself, not a touch; a human cancel, retry or decision
 * is. Usage an attempt did not report, or did not split into cache and fresh input, is counted apart, never as zero.
 */
import type { LaterPass } from './later-pass.ts'
import { attemptCause, outsideCause, type OutsideCause } from './outside.ts'
import type { WorkRecord } from './record.ts'

/** One failed attempt, failed or inconclusive verdict, hold, failed publish or operator touch, read from `event` (`<type>#<index>`); `outside` when its reason is an Outside failure, `unknown` when its cause cannot be placed, absent for a failure of the change. */
export interface Failure { event: string; kind: 'attempt' | 'attempt-lost' | 'verdict' | 'hold' | 'publish' | 'touch'; reason: string; outside?: OutsideCause; unknown?: true; classified?: ClassifiedFailure }

/** A Classifier's recorded answer about an `unknown` failure (cls-1), for the report only: nothing decides from it. */
export interface ClassifiedFailure { label: string; confidence: number; /** The `classification@1` Artifact. */ classification: string }
/** The recorded Classification of a failure, if any; never asks a model. */
export type ClassifiedLookup = (failure: Pick<Failure, 'event' | 'kind' | 'reason'>, record: WorkRecord) => ClassifiedFailure | undefined
/** What the report reads of the optional Classifier row: recorded answers, and asking for those a Work lacks. */
export interface FailureClassifier {
  lookup: ClassifiedLookup
  /** Classify the failures of `record` whose rules answer `unknown` and that have no answer yet. Never throws. */
  classify(record: WorkRecord): Promise<void>
}

export interface WorkSummary {
  id: string
  status: WorkRecord['state']['status']
  durationMs: number
  attempts: number
  /** Time steps waited for a free Account or check slot, summed. */
  waitedForSlotMs: number
  /** Worker attempts that failed because their Account was out of quota (`limited`, or the old `rateLimited`). */
  rateLimitedAttempts: number
  operatorTouches: number
  touches: string[]
  /** Every failure and touch with its classification; `outsideFailures + changeFailures + unknownFailures === failures.length`. */
  failures: Failure[]
  /** The `unknown` failures that carry a Classification, counted by its label; absent when none does (the Classifier row is off, or has classified none). */
  classifiedFailures?: Record<string, number>
  outsideFailures: number
  changeFailures: number
  /** Failures whose cause System cannot place: neither Outside nor a failure of the change. */
  unknownFailures: number
  /** `inputTokens` is the total; fresh input counts only attempts that split their cache use. */
  usage: {
    inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; freshInputTokens: number; outputTokens: number
    observedAttempts: number; unsplitAttempts: number; unknownAttempts: number
    /** The CLI's client-side API-equivalent cost estimate (not what a subscription is billed), over the attempts that report it, old records' `costUsd` included; absent when none does. */
    costUsdEstimate?: number
  }
}

/** `classified`: the recorded Classifications (cls-1); an `unknown` failure that has one is reported under its label, marked as classified. The classes and counts are the rules' alone. `later` (cls-5): the cross-Work view, from the Host's records: a failed check whose change passed it later, in this Work or another, is `flaky`, and a "no change" after a reopen whose previous change passed later is `process`; without it only this Work is read. */
export function summarize(record: WorkRecord, classified?: ClassifiedLookup, later?: LaterPass): WorkSummary {
  const touches: string[] = []
  const usage: WorkSummary['usage'] = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, freshInputTokens: 0, outputTokens: 0, observedAttempts: 0, unsplitAttempts: 0, unknownAttempts: 0 }
  let attempts = 0
  let waitedForSlotMs = 0
  let rateLimitedAttempts = 0
  const failures: Failure[] = []
  const add = (index: number, kind: Failure['kind'], reason: string, cause: OutsideCause | 'unknown' | undefined = kind === 'verdict' ? outsideCause(reason, 'verdict') : outsideCause(reason)) => {
    failures.push({ event: `${record.events[index]!.type}#${index}`, kind, reason, ...(cause === 'unknown' ? { unknown: true as const } : cause ? { outside: cause } : {}) })
  }
  // cls-3: a check that failed and then passed on the re-run of the same change (`rerunOf`) is flaky.
  const flakyVerdicts = new Set(record.events.flatMap((e) => (e.type === 'verified' && e.verdict === 'pass' && e.rerunOf ? [e.rerunOf] : [])))
  // cls-3: a "no change" on a step reopened with a previous change that a later verdict passed unchanged is System's (a Process failure).
  const processAfterCorrectChange = (index: number, stepId: string): boolean => {
    const previous = record.events.slice(0, index).findLast((e) => e.type === 'reopened' && e.stepId === stepId)
    const kept = previous?.type === 'reopened' ? previous.previous : undefined
    return !!kept && (record.events.slice(index + 1).some((e) => e.type === 'verified' && e.verdict === 'pass' && e.subject === kept) || !!later?.(kept, undefined, record, index))
  }
  const lastCause = () => failures.at(-1)?.unknown ? 'unknown' as const : failures.at(-1)?.outside
  const lastVerdict = () => failures.findLast((f) => f.kind === 'verdict')
  for (const [index, event] of record.events.entries()) {
    if (event.type === 'observed' && event.status === 'failed') add(index, 'attempt', event.reason ?? '', event.rateLimited ? 'quota' : /^no change\b/.test(event.reason ?? '') && processAfterCorrectChange(index, event.stepId) ? 'process' : attemptCause(event.reason ?? ''))
    if (event.type === 'attempt-lost') add(index, 'attempt-lost', event.reason, 'restart')
    if (event.type === 'verified' && (event.verdict === 'fail' || event.verdict === 'inconclusive')) add(index, 'verdict', event.reason, (event.verdictId && flakyVerdicts.has(event.verdictId)) || (event.verdict === 'fail' && later?.(event.subject, event.stepId, record, index)) ? 'flaky' : outsideCause(event.reason, 'verdict'))
    if (event.type === 'effect-observed' && event.state === 'failed') add(index, 'publish', event.reason, event.rejected === 'conflict' ? 'conflict' : undefined)
    if (event.type === 'terminal' && event.outcome === 'held' && event.reason !== 'verification passed; awaiting operator approval') {
      add(index, 'hold', event.reason, /^inconclusive verification/.test(event.reason) ? (lastVerdict()?.unknown ? 'unknown' : lastVerdict()?.outside) : undefined)
    }
    if (event.type === 'dispatched') {
      if (event.executor === 'worker') attempts += 1
      waitedForSlotMs += event.waitedMs ?? 0
    }
    if (event.type === 'observed' && (event.rateLimited || event.limited)) rateLimitedAttempts += 1
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
    if (event.type === 'reopened' && event.caller?.type === 'human') { touches.push(`retry ${event.stepId}`); add(index, 'touch', event.reason, lastCause()) }
    if (event.type === 'decided') { touches.push(`${event.decision} ${event.stepId}`); add(index, 'touch', event.reason, lastCause()) }
  }
  const first = Date.parse(record.events[0]!.at)
  const last = Date.parse(record.events.at(-1)!.at)
  const counts: Record<string, number> = {}
  if (classified) {
    for (const failure of failures) {
      const answer = failure.unknown && failure.kind !== 'touch' ? classified(failure, record) : undefined
      if (!answer) continue
      failure.classified = answer
      counts[answer.label] = (counts[answer.label] ?? 0) + 1
    }
  }
  return { id: record.id, status: record.state.status, durationMs: last - first, attempts, waitedForSlotMs, rateLimitedAttempts, operatorTouches: touches.length, touches, failures, ...(Object.keys(counts).length ? { classifiedFailures: counts } : {}), outsideFailures: failures.filter((f) => f.outside).length, changeFailures: failures.filter((f) => !f.outside && !f.unknown).length, unknownFailures: failures.filter((f) => f.unknown).length, usage }
}
