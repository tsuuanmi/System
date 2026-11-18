/** The Work controller's next move as a pure decision over a record and its pinned spec (ADR-0002: no domain branch); the controller carries it out. */
import { WorkError } from './errors.ts'
import type { Verdict } from './kinds.ts'
import { OUTSIDE_HOLD, outsideHoldReason } from './outside.ts'
import { TERMINAL, type NewEvent, type WorkEvent, type WorkRecord, type WorkState } from './record.ts'
import { isEffectStep, isVerifyStep, isWorkerStep, type ResolvedSpec, type Step } from './workflow.ts'

type Rec = Pick<WorkRecord, 'state' | 'events'>
type WorkerStep = Extract<Step, { capabilities: string[] }>

export interface Finish { move: 'finish'; outcome: 'succeeded' | 'failed' | 'held'; reason: string; awaiting?: string; satisfied?: { result: 'satisfied'; evidence: Record<string, string> }; hold?: 'approval' | 'inconclusive' }
/** The moves: `finish` ends or holds the Work (as `terminal` records it); a `reopen`'s `verdict`, when present, is stored first and its ID becomes the event's `failure`. */
export interface Reopen { move: 'reopen'; event: Extract<NewEvent, { type: 'reopened' }>; verdict?: Verdict }
export type Move = Finish | { move: 'wait' } | { move: 'skip'; steps: { stepId: string; reason: string }[] } | { move: 'dispatch'; steps: Step[] }

/** The Artifact a `$steps.<step>.<slot>` reference names, if written; a joined Sub-workflow's step ID has dots of its own. */
const written = (state: Pick<WorkState, 'steps'>, ref: string): string | undefined => {
  const names = ref.split('.')
  return state.steps[names.slice(1, -1).join('.')]?.outputs[names.at(-1)!]
}

/** Resolve a reference to an exact Artifact ID from recorded state. */
export function resolveRef(state: Pick<WorkState, 'input' | 'steps'>, ref: string): string {
  const id = ref === '$work.input' ? state.input : written(state, ref)
  if (!id) throw new WorkError(`${ref} has no recorded Artifact`)
  return id
}

/** A verify step's verdict about an output that has since changed no longer counts. */
export function verdictOf(state: WorkState, spec: ResolvedSpec, stepId: string): string | undefined {
  const s = spec.steps.find((step) => step.id === stepId)
  const step = state.steps[stepId]!
  if (!s || !isVerifyStep(s) || !step.verdict) return step.verdict
  return (s.verify.subject === '$work.input' ? state.input : written(state, s.verify.subject)) === step.subject ? step.verdict : 'stale'
}

/** Whether a step is done for the steps after it: it succeeded, or its condition was not met and it was skipped. */
export function settled(state: WorkState, stepId: string): boolean {
  return state.steps[stepId]!.state === 'succeeded' || state.steps[stepId]!.state === 'skipped'
}

/** Every step that depends, directly or not, on `stepId`, in spec order. */
export function dependentsOf(spec: ResolvedSpec, stepId: string): string[] {
  const found = new Set<string>([stepId])
  for (const s of spec.steps) if ((s.dependsOn ?? []).some((d) => found.has(d))) found.add(s.id)
  found.delete(stepId)
  return spec.steps.map((s) => s.id).filter((id) => found.has(id))
}

/** Why a ready step does not run: its `when` output was not written, or its `unless` output was; undefined when it runs. */
function skipReason(state: WorkState, s: Step): string | undefined {
  const { when, unless } = s as { when?: string; unless?: string }
  if (when && !written(state, when)) return `${when} was not written`
  if (unless && written(state, unless)) return `${unless} was written`
  return undefined
}

/** The operator's approval of a step since it was last reset, if any. */
export function decisionOf(record: Rec, stepId: string): Extract<WorkEvent, { type: 'decided' }> | undefined {
  const event = record.events.findLast((e) => e.type === 'decided' && e.stepId === stepId)
  return event?.type === 'decided' && record.state.steps[stepId]!.decision === 'approved' ? event : undefined
}

/** The approval of an effect step that requires all of `verifyIds`, if any (df-25: one approval serves the accept step too). */
function effectDecisionOn(record: Rec, spec: ResolvedSpec, verifyIds: string[]): Extract<WorkEvent, { type: 'decided' }> | undefined {
  return spec.steps.flatMap((t) => (isEffectStep(t) && verifyIds.every((id) => t.effect.requires.includes(id)) ? [decisionOf(record, t.id)] : [])).find(Boolean)
}

/** The verdict of a check in `retry.onFail` that automatically reopened this step, with its change to hand back (`retry.rerunUnchanged`). */
export function rerunOf(record: Rec, s: WorkerStep): string | undefined {
  const r = record.state.steps[s.id]!.reopening
  if (!s.retry?.rerunUnchanged || !r?.automatic || !r.failure || r.failedEffect || !r.previous) return undefined
  return record.events.some((v) => v.type === 'verified' && v.verdictId === r.failure && v.verdict === 'fail' && s.retry?.onFail.includes(v.stepId)) ? r.failure : undefined
}

/** The Workflow's `retry` (Item df-7; [workflow composition](../../../docs/architecture/workflow-composition.md)), with nothing in flight: counted from events, the latest step in dependency order with budget is reopened. */
export function retryMove(record: Rec, spec: ResolvedSpec): Reopen | undefined {
  if (TERMINAL.has(record.state.status)) return undefined
  const { state, events } = record
  const workers = spec.steps.filter(isWorkerStep)
  const reopen = (s: WorkerStep, reason: string, failure?: string): Reopen => {
    const previous = failure ? state.steps[s.id]!.outputs[s.outputs[0]!] : undefined
    return { move: 'reopen', event: { type: 'reopened', automatic: true, stepId: s.id, reason, ...(failure ? { failure } : {}), ...(previous ? { previous } : {}), reset: [s.id, ...dependentsOf(spec, s.id)] } }
  }
  const autoReopens = (stepId: string, source: string): number => events.filter((e) => {
    if (e.type !== 'reopened' || !e.automatic || e.stepId !== stepId) return false
    if (e.failedEffect) return e.failedEffect === source
    if (source === stepId) return !e.failure
    return events.some((v) => v.type === 'verified' && v.stepId === source && v.verdictId === e.failure)
  }).length
  const target = (source: string): WorkerStep | undefined => workers.findLast((s) => s.retry?.onFail.includes(source) && state.steps[s.id]!.state === 'succeeded' && autoReopens(s.id, source) < s.retry.max)
  for (const v of spec.steps.filter(isVerifyStep)) {
    if (verdictOf(state, spec, v.id) !== 'fail') continue
    const verified = events.findLast((e) => e.type === 'verified' && e.stepId === v.id)
    const nearest = target(v.id)
    if (nearest && verified?.type === 'verified') return reopen(nearest, `${v.id} failed: ${verified.reason}`, verified.verdictId)
  }
  // An effect step observed as a conflict or a failed merge check (`rejected`) reopens the Worker step that lists it, on the base's new tip; an unknown outcome never is.
  for (const e of spec.steps.filter(isEffectStep)) {
    if (state.steps[e.id]!.state !== 'failed') continue
    const observed = events.findLast((x) => x.type === 'effect-observed' && x.stepId === e.id)
    const base = observed?.type === 'effect-observed' ? observed.detail?.base : undefined
    if (observed?.type !== 'effect-observed' || observed.state !== 'failed' || !observed.rejected || (!base && observed.rejected !== 'build-output')) continue
    const t = target(e.id)
    const previous = t && state.steps[t.id]!.outputs[t.outputs[0]!]
    if (!t || !previous) continue
    const verdict: Verdict = { subject: previous, criteria: previous, capability: 'publish', verifier: { ref: `step:${e.id}`, version: '1' }, verdict: 'fail', reason: observed.reason, evidence: [] }
    return { move: 'reopen', verdict, event: { type: 'reopened', automatic: true, failedEffect: e.id, stepId: t.id, reason: `${e.id} failed: ${observed.reason}`, previous, ...(base ? { base } : {}), reset: [t.id, ...dependentsOf(spec, t.id)] } }
  }
  for (const s of workers) {
    if (!s.retry?.onFail.includes(s.id) || state.steps[s.id]!.state !== 'failed' || autoReopens(s.id, s.id) >= s.retry.max) continue
    const observed = events.findLast((e) => e.type === 'observed' && e.stepId === s.id)
    if (observed?.type === 'observed' && observed.retryable) return reopen(s, `${s.id} failed and may be tried afresh: ${observed.reason ?? 'no reason'}`)
  }
  return undefined
}

/** After retries: fail, wait, skip, hold, finish or dispatch. `busy`: attempts are in flight. */
export function nextMove(record: Rec, spec: ResolvedSpec, busy: boolean): Move {
  const { state } = record
  const failed = spec.steps.find((s) => ['failed', 'cancelled'].includes(state.steps[s.id]!.state))
  // A failed step fails the Work once the attempts in flight have reported.
  if (failed) return busy ? { move: 'wait' } : { move: 'finish', outcome: 'failed', reason: `step ${failed.id} ${state.steps[failed.id]!.state}` }
  // A `fail` or `error` verdict no retry reopened is the Work's outcome (inconclusive waits for the operator): nothing after it starts, so nothing publishes what failed its check.
  const verdicts = spec.steps.filter(isVerifyStep).map((s) => [s.id, verdictOf(state, spec, s.id)] as const)
  const refused = verdicts.find(([stepId, verdict]) => (verdict === 'fail' || verdict === 'error') && spec.steps.some((s) => s.dependsOn?.includes(stepId)))
  if (refused) return busy ? { move: 'wait' } : { move: 'finish', outcome: 'failed', reason: `verification did not pass: ${refused[0]}=${refused[1]}` }
  const ready = spec.steps.filter((s) => state.steps[s.id]!.state === 'pending' && (s.dependsOn ?? []).every((d) => settled(state, d)))
  // A step whose condition on an optional output is not met does not run (ro-15); what comes after it goes on.
  const skips = ready.flatMap((s) => { const reason = skipReason(state, s); return reason ? [{ stepId: s.id, reason }] : [] })
  if (skips.length) return { move: 'skip', steps: skips }
  if (!ready.length) return busy ? { move: 'wait' } : settleMove(record, spec)
  // The third Outside failure in a row on a step holds the Work instead of dispatching it again (cm-2, anti-windup).
  for (const next of ready) {
    if (!isWorkerStep(next) && !isVerifyStep(next)) continue
    const run = state.steps[next.id]!.outside
    if (run && run.count >= OUTSIDE_HOLD) return busy ? { move: 'wait' } : { move: 'finish', outcome: 'held', reason: outsideHoldReason(next.id, run), awaiting: next.id }
  }
  return { move: 'dispatch', steps: ready }
}

/** With no accept step, every verify step still decides: missing evidence is never a pass. */
function settleMove(record: Rec, spec: ResolvedSpec): Finish {
  const verifies = spec.steps.filter(isVerifyStep).filter((s) => record.state.steps[s.id]!.state !== 'skipped')
  const verdicts = verifies.map((s) => [s.id, verdictOf(record.state, spec, s.id)] as const)
  const bad = verdicts.filter(([, verdict]) => verdict !== 'pass' && verdict !== 'inconclusive')
  if (bad.length) return { move: 'finish', outcome: 'failed', reason: `verification did not pass: ${bad.map(([id, v]) => `${id}=${v ?? 'missing'}`).join(', ')}` }
  const unsure = verdicts.filter(([id, verdict]) => verdict === 'inconclusive' && !decisionOf(record, id))
  if (unsure.length) return { move: 'finish', outcome: 'held', reason: `inconclusive verification needs an operator decision: ${unsure.map(([id]) => id).join(', ')}`, hold: 'inconclusive' }
  // A passing verify step with `result` says the Item already holds: the Work ends Satisfied, with its verdict as the evidence.
  const satisfying = verifies.find((s) => s.result && verdictOf(record.state, spec, s.id) === 'pass')
  if (satisfying?.result) {
    const verdict = record.events.findLast((e) => e.type === 'verified' && e.stepId === satisfying.id)
    return { move: 'finish', outcome: 'succeeded', reason: `${satisfying.result}: ${satisfying.id} passed`, satisfied: { result: satisfying.result, evidence: { [`${satisfying.id}.verdict`]: (verdict?.type === 'verified' && verdict.verdictId) || '' } } }
  }
  return { move: 'finish', outcome: 'succeeded', reason: 'every step succeeded' }
}

/** What an accept step decides, once it is ready and nothing else runs. */
export function acceptMove(record: Rec, spec: ResolvedSpec, s: Extract<Step, { accept: unknown }>): Finish {
  const verdicts = s.accept.requires.map((stepId) => [stepId, verdictOf(record.state, spec, stepId)] as const)
  const notPass = verdicts.filter(([, verdict]) => verdict !== 'pass')
  // Missing evidence is never a pass; inconclusive is held for the operator, not failed (ADR-0003 decision 8).
  if (notPass.some(([, verdict]) => verdict !== 'inconclusive')) return { move: 'finish', outcome: 'failed', reason: `required verification did not pass: ${notPass.map(([id, v]) => `${id}=${v ?? 'missing'}`).join(', ')}` }
  const decided = decisionOf(record, s.id) ?? (notPass.length ? effectDecisionOn(record, spec, notPass.map(([id]) => id)) : undefined)
  if (notPass.length) {
    if (!decided) return { move: 'finish', outcome: 'held', reason: `inconclusive verification needs an operator decision: ${notPass.map(([id]) => id).join(', ')}`, awaiting: s.id, hold: 'inconclusive' }
    return { move: 'finish', outcome: 'succeeded', reason: `accepted by ${decided.caller.operatorId} despite inconclusive ${notPass.map(([id]) => id).join(', ')}: ${decided.reason}` }
  }
  if (s.accept.approval === 'operator' && !decided) return { move: 'finish', outcome: 'held', reason: 'verification passed; awaiting operator approval', awaiting: s.id, hold: 'approval' }
  return { move: 'finish', outcome: 'succeeded', reason: decided ? `accepted by ${decided.caller.operatorId}: ${decided.reason}` : `accepted on ${s.accept.requires.join(', ')}` }
}
