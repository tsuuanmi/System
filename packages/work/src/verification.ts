/**
 * Verification: judge a subject under pinned criteria, once, for the Work
 * controller and the merge queue's re-check (ADR-0003: a verdict binds to the
 * exact Artifact ID, criteria and verifier version). Also the one definition of
 * when a verdict is flaky.
 */
import type { Verdict } from './kinds.ts'
import type { WorkEvent } from './record.ts'
import type { VerifierPort, VerifyRequest, VerifyResult } from './registry.ts'

/** A verdict counts only for the exact subject and criteria asked about, with stored evidence; anything else is `error`. */
export function bindVerdict(result: VerifyResult, subject: string, criteria: string, exists: (id: string) => boolean): Pick<VerifyResult, 'verdict' | 'reason' | 'evidence'> {
  const evidence = [...new Set(result.evidence ?? [])]
  const problems: string[] = []
  if (result.subject !== subject) problems.push(`it judged ${result.subject}, not the subject ${subject}`)
  if (result.criteria !== criteria) problems.push(`it used criteria ${result.criteria}, not the pinned ${criteria}`)
  const missing = evidence.filter((id) => !exists(id))
  if (missing.length) problems.push(`its evidence ${missing.join(', ')} is not stored`)
  if (result.verdict === 'pass' && !evidence.length) problems.push('a pass needs evidence')
  if (problems.length) return { verdict: 'error', reason: `verdict refused: ${problems.join('; ')} (verifier said ${result.verdict}: ${result.reason})`, evidence: evidence.filter(exists) }
  return { verdict: result.verdict, reason: result.reason, evidence }
}

/** What Verification reads and writes of the Artifact store. */
export interface VerificationStore {
  kindOf(id: string): string | undefined
  exists(id: string): boolean
  putVerdict(verdict: Verdict): Promise<string>
}

/** The verifier and version pinned for a check at admission. */
export interface VerifierPin {
  ref: string
  version: string
}

/** Why a verifier did not judge: its pin changed, it does not accept the subject's kind, or it threw. */
interface Refusal {
  kind: 'pin' | 'accepts' | 'threw'
  /** `hold` only for a pin mismatch under `onPinMismatch: 'hold'`; else `error`. */
  verdict: 'error' | 'hold'
  reason: string
}

export interface AskInput {
  verifier: VerifierPort
  /** The pin from admission; absent when the Work pinned none. */
  pin?: VerifierPin
  /** Deliberate (PLAN DP decision: a merge awaits an Approval): the controller refuses a changed pin with `error`, the merge check `hold`s. */
  onPinMismatch: 'error' | 'hold'
  request: VerifyRequest
  /** Wraps the `verify` call only (the merge check takes a check slot there); the controller's checks step took its slot before. */
  around?: <T>(run: () => Promise<T>) => Promise<T>
}

/** Check the pin and `accepts` against the subject's kind, then ask the verifier; a throw is a refusal with an `error` verdict. */
export async function askVerifier(store: Pick<VerificationStore, 'kindOf'>, { verifier, pin, onPinMismatch, request, around }: AskInput): Promise<{ refusal: Refusal } | { result: VerifyResult }> {
  if (pin && (pin.ref !== verifier.ref || pin.version !== verifier.version)) {
    return { refusal: { kind: 'pin', verdict: onPinMismatch, reason: `pinned ${pin.ref}@${pin.version} at admission; ${verifier.ref}@${verifier.version} is enabled now` } }
  }
  const kind = store.kindOf(request.subject)
  if (!kind || !verifier.accepts.includes(kind)) return { refusal: { kind: 'accepts', verdict: 'error', reason: `${verifier.ref} judges ${verifier.accepts.join(', ')}, not ${kind ?? 'a missing Artifact'}` } }
  try {
    return { result: await (around ? around(() => verifier.verify(request)) : verifier.verify(request)) }
  } catch (error) {
    return { refusal: { kind: 'threw', verdict: 'error', reason: `the verifier threw: ${(error as Error).message}` } }
  }
}

/** A refusal as the verdict the controller records for it. */
export const refusedResult = (refusal: Refusal, subject: string, criteria: string): VerifyResult => ({ verdict: 'error', reason: refusal.reason, subject, criteria, evidence: [] })

/** A check that failed, and the second run of it on the same change (`retry.rerunUnchanged`). */
interface FirstRun {
  verdictId: string
  evidence?: string[]
}

/** Bind a verdict to its subject, criteria and evidence, settle it against an earlier failed run, and store it. */
export async function settleVerdict(store: VerificationStore, input: { verifier: VerifierPin; capability: string; subject: string; criteria: string; result: VerifyResult; first?: FirstRun }): Promise<{ verdictId: string; bound: Pick<VerifyResult, 'verdict' | 'reason' | 'evidence'> }> {
  const { verifier, capability, subject, criteria, result, first } = input
  const bound = rerunVerdict(bindVerdict(result, subject, criteria, (id) => store.exists(id)), first)
  const verdictId = await store.putVerdict({ subject, criteria, capability, verifier: { ref: verifier.ref, version: verifier.version }, verdict: bound.verdict, reason: bound.reason, evidence: bound.evidence ?? [] })
  return { verdictId, bound }
}

// ---- Flaky: the one definition ----

/** The second run of a check on the same change: a pass is flaky, a second fail is held for the operator as inconclusive. */
export function rerunVerdict<B extends Pick<VerifyResult, 'verdict' | 'reason' | 'evidence'>>(bound: B, first?: FirstRun): B | Pick<VerifyResult, 'verdict' | 'reason' | 'evidence'> {
  if (first && bound.verdict === 'pass') return { ...bound, reason: `flaky: failed (${first.verdictId}) then passed on the same change; ${bound.reason}` }
  if (first && bound.verdict === 'fail') return { verdict: 'inconclusive', reason: `failed twice on the same change, held for an operator decision (verifier said fail: ${bound.reason}); first run ${first.verdictId}`, evidence: [...(first.evidence ?? []), ...(bound.evidence ?? [])] }
  return bound
}

/** The failed run of a step that its latest run re-runs on the same change (an `observed` event after it names it in `unchangedAfter`). */
export function firstRunOf(events: readonly WorkEvent[], stepId: string): FirstRun | undefined {
  const last = events.findLast((e) => e.type === 'verified' && e.stepId === stepId)
  if (last?.type !== 'verified' || last.verdict !== 'fail' || !last.verdictId) return undefined
  const { seq, verdictId } = last
  return events.some((e) => e.type === 'observed' && e.seq > seq && e.unchangedAfter === verdictId) ? { verdictId, evidence: last.evidence } : undefined
}

/** The verdicts that failed and then passed on a re-run of the same change. */
export const flakyFirstRuns = (events: readonly WorkEvent[]): Set<string> => new Set(events.flatMap((e) => (e.type === 'verified' && e.verdict === 'pass' && e.rerunOf ? [e.rerunOf] : [])))

const VERIFIER_RERUN_MARK = 'then passed on the change (flaky)'

/** The verifier's own re-run (sc-13): the reason of a pass that failed first on the change and passed on a re-run; `isFlakyPass` reads it. */
export const verifierRerunReason = (names: string[], firstFailed: string): string => `re-run once: ${names.join(', ')} failed, ${VERIFIER_RERUN_MARK}; first run: ${firstFailed}; `

/** Whether a pass is flaky: the controller's re-run of the check (`rerunOf`), or the verifier's own re-run. */
export const isFlakyPass = (verdict: { verdict: string; reason: string; rerunOf?: string }): boolean => verdict.verdict === 'pass' && (!!verdict.rerunOf || verdict.reason.includes(VERIFIER_RERUN_MARK))
