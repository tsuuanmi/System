/**
 * Whether a recorded failure reason is an Outside failure (GLOSSARY): machine
 * load or a timeout, an Account's quota or rate limit, a Host restart or a lost
 * attempt, a conflict with other work at publish, a slow Host. Deterministic
 * from the event's `cause` when its port wrote one, else from the reason text (old records); a verdict's reason is Outside only by the marker its Verifier writes, and an attempt reason no
 * pattern knows is `unknown`. The patterns live here, except quota's, which is limits.ts's.
 */
import { parseCheckFailure } from './failure-class.ts'
import { isQuotaLimited } from './limits.ts'
import type { PortCause, WorkEvent } from './record.ts'

/** `flaky` and `process` (cls-3) are placed by structure in `summarize`, never by a reason's text: a check that passed on the re-run of the same change, and a "no change" after a correct change (a Process failure, GLOSSARY). */
export type OutsideCause = 'quota' | 'restart' | 'conflict' | 'load' | 'slow-host' | 'attach' | 'flaky' | 'process'

const PATTERNS: [OutsideCause, RegExp][] = [
  ['restart', /host stopped before the attempt reported|host restart/i],
  ['conflict', /merge conflict with /i],
  ['load', /the base fails it too/i],
  ['attach', /attach text failed/i],
  ['slow-host', /timed out after|timeout/i],
]

/** Outside failures in a row on one step that hold the Work (cm-2); `OutsideRun` is the run kept in the step's state. */
export type OutsideRun = { count: number; cause: OutsideCause; reason: string }
export const OUTSIDE_HOLD = 3

/** The reason of a hold by that count; `outsideCause` reads the cause back from it. */
export const outsideHoldReason = (stepId: string, run: OutsideRun): string =>
  `step ${stepId} held after ${run.count} Outside failures in a row (last cause: ${run.cause}): ${run.reason}`

/** The Outside failures in a row on `stepId` after `event` (cm-2): an `attempt-lost`, or a `limited` or attach attempt extends the run; a finished attempt, a human's retry or Approval, and a skip end it (`undefined`). `fold` keeps it in the step's state. */
export function outsideNext(run: OutsideRun | undefined, event: WorkEvent, stepId: string): OutsideRun | undefined {
  const more = (cause: OutsideCause, reason: string): OutsideRun => ({ count: (run?.count ?? 0) + 1, cause, reason })
  if (event.type === 'attempt-lost' && event.stepId === stepId) return more('restart', event.reason)
  if (event.type === 'observed' && event.stepId === stepId) return event.limited ? more('quota', event.reason ?? '') : event.status === 'failed' && outsideCause(event.reason ?? '', undefined, event.cause) === 'attach' ? more('attach', event.reason ?? '') : undefined
  if ((event.type === 'verified' || event.type === 'skipped' || event.type === 'decided') && event.stepId === stepId) return undefined
  if (event.type === 'reopened' && (event.stepId === stepId || event.reset?.includes(stepId))) return undefined
  return run
}

export const outsideRun = (events: readonly WorkEvent[], stepId: string): { count: number; cause?: OutsideCause; reason?: string } =>
  events.reduce<OutsideRun | undefined>((run, event) => outsideNext(run, event, stepId), undefined) ?? { count: 0 }

/**
 * The Outside cause of a reason, or `undefined`. `from: 'verdict'` is a verifier's reason: it is Outside only by the marker
 * its Verifier writes (the base re-run's `cause: 'load'`, or in old records its "the base fails it too"), never by a pattern, so a test's name cannot make
 * it `restart` or `quota`. Otherwise the reason is a Worker attempt's, and the patterns apply, unless it is a check failure
 * System wrote (`failed: <check>: ...`), which is a failure of the change. A `cause` the port recorded decides first; the patterns are the fallback for events without one. Read at report time, so old records classify by
 * the same rule. An attempt reason no pattern knows is `unknown` to the report (`attemptCause`), not a failure of the change.
 */
export function outsideCause(reason: string, from?: 'verdict', cause?: PortCause): OutsideCause | undefined {
  const held = /^step \S+ held after \d+ Outside failures in a row \(last cause: (\w+)\)/.exec(reason)
  if (held) return held[1] as OutsideCause
  if (cause && (from !== 'verdict' || cause === 'load')) return cause
  if (from === 'verdict') return /the base fails it too/i.test(reason) ? 'load' : undefined
  if (parseCheckFailure(reason)) return undefined
  if (isQuotaLimited(reason)) return 'quota'
  return PATTERNS.find(([, pattern]) => pattern.test(reason))?.[0]
}

/** The cause of a failed Worker attempt's reason for the report: an Outside cause, or `unknown` (neither Outside nor a failure of the change). */
export const attemptCause = (reason: string, cause?: PortCause): OutsideCause | 'unknown' => outsideCause(reason, undefined, cause) ?? 'unknown'
