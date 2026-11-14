/**
 * Whether a recorded failure reason is an Outside failure (GLOSSARY): machine
 * load or a timeout, an Account's quota or rate limit, a Host restart or a lost
 * attempt, a conflict with other work at publish, a slow Host. Deterministic
 * from the reason text; a reason no pattern knows is a failure of the change
 * (`undefined`). The patterns live here and nowhere else.
 */
import type { WorkEvent } from './record.ts'

export type OutsideCause = 'quota' | 'restart' | 'conflict' | 'load' | 'slow-host'

const PATTERNS: [OutsideCause, RegExp][] = [
  ['quota', /out of credits|rate[- ]limit|quota|usage limit|too many requests/i],
  ['restart', /host stopped before the attempt reported|host restart/i],
  ['conflict', /merge conflict with /i],
  ['load', /the base fails it too/i],
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
    else if (event.type === 'observed' && event.stepId === stepId) run = event.limited ? { count: run.count + 1, cause: 'quota', reason: event.reason ?? '' } : { count: 0 }
    else if (event.type === 'verified' || event.type === 'skipped' || event.type === 'decided') { if (event.stepId === stepId) run = { count: 0 } }
    else if (event.type === 'reopened' && (event.stepId === stepId || event.reset?.includes(stepId))) run = { count: 0 }
  }
  return run
}

export function outsideCause(reason: string): OutsideCause | undefined {
  const held = /^step \S+ held after \d+ Outside failures in a row \(last cause: (\w+)\)/.exec(reason)
  if (held) return held[1] as OutsideCause
  return PATTERNS.find(([, pattern]) => pattern.test(reason))?.[0]
}
