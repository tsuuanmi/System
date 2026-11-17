/**
 * Whether a recorded failure reason is an Outside failure (GLOSSARY): machine
 * load or a timeout, an Account's quota or rate limit, a Host restart or a lost
 * attempt, a conflict with other work at publish, a slow Host. Deterministic
 * from the reason text; a verdict's reason is Outside only by the marker its Verifier writes, and an attempt reason no
 * pattern knows is `unknown`. The patterns live here, except quota's, which is limits.ts's.
 */
import { parseCheckFailure } from './failure-class.ts'
import { isQuotaLimited } from './limits.ts'
import type { WorkEvent } from './record.ts'

/** `flaky` and `process` (cls-3) are placed by structure in `summarize`, never by a reason's text: a check that passed on the re-run of the same change, and a "no change" after a correct change (a Process failure, GLOSSARY). */
export type OutsideCause = 'quota' | 'restart' | 'conflict' | 'load' | 'slow-host' | 'attach' | 'flaky' | 'process'

const PATTERNS: [OutsideCause, RegExp][] = [
  ['restart', /host stopped before the attempt reported|host restart/i],
  ['conflict', /merge conflict with /i],
  ['load', /the base fails it too/i],
  ['attach', /attach text failed/i],
  ['slow-host', /timed out after|timeout/i],
]

/** Outside failures in a row on one step that hold the Work (cm-2). */
export const OUTSIDE_HOLD = 3

/** The reason of a hold by that count; `outsideCause` reads the cause back from it. */
export const outsideHoldReason = (stepId: string, run: { count: number; cause: OutsideCause; reason: string }): string =>
  `step ${stepId} held after ${run.count} Outside failures in a row (last cause: ${run.cause}): ${run.reason}`

/**
 * The consecutive re-dispatches of `stepId` caused by an Outside failure (an `attempt-lost`, or a `limited`
 * attempt), derived from the events; the last cause and its reason. An attempt of the step that finishes, a
 * human's retry or Approval, and a skip reset it. `count` is 0 when the last thing was not an Outside failure.
 */
export function outsideRun(events: readonly WorkEvent[], stepId: string): { count: number; cause?: OutsideCause; reason?: string } {
  let run: { count: number; cause?: OutsideCause; reason?: string } = { count: 0 }
  for (const event of events) {
    if (event.type === 'attempt-lost' && event.stepId === stepId) run = { count: run.count + 1, cause: 'restart', reason: event.reason }
    else if (event.type === 'observed' && event.stepId === stepId) run = event.limited ? { count: run.count + 1, cause: 'quota', reason: event.reason ?? '' } : event.status === 'failed' && outsideCause(event.reason ?? '') === 'attach' ? { count: run.count + 1, cause: 'attach', reason: event.reason ?? '' } : { count: 0 }
    else if (event.type === 'verified' || event.type === 'skipped' || event.type === 'decided') { if (event.stepId === stepId) run = { count: 0 } }
    else if (event.type === 'reopened' && (event.stepId === stepId || event.reset?.includes(stepId))) run = { count: 0 }
  }
  return run
}

/**
 * The Outside cause of a reason, or `undefined`. `from: 'verdict'` is a verifier's reason: it is Outside only by the marker
 * its Verifier writes (the base re-run's "the base fails it too": `load`), never by a pattern, so a test's name cannot make
 * it `restart` or `quota`. Otherwise the reason is a Worker attempt's, and the patterns apply, unless it is a check failure
 * System wrote (`failed: <check>: ...`), which is a failure of the change. Read at report time, so old records classify by
 * the same rule. An attempt reason no pattern knows is `unknown` to the report (`attemptCause`), not a failure of the change.
 */
export function outsideCause(reason: string, from?: 'verdict'): OutsideCause | undefined {
  const held = /^step \S+ held after \d+ Outside failures in a row \(last cause: (\w+)\)/.exec(reason)
  if (held) return held[1] as OutsideCause
  if (from === 'verdict') return /the base fails it too/i.test(reason) ? 'load' : undefined
  if (parseCheckFailure(reason)) return undefined
  if (isQuotaLimited(reason)) return 'quota'
  return PATTERNS.find(([, pattern]) => pattern.test(reason))?.[0]
}

/** The cause of a failed Worker attempt's reason for the report: an Outside cause, or `unknown` (neither Outside nor a failure of the change). */
export const attemptCause = (reason: string): OutsideCause | 'unknown' => outsideCause(reason) ?? 'unknown'
