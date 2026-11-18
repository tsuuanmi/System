import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptMove, nextMove, rerunOf, retryMove } from '../src/next-move.ts'
import { fold, type WorkEvent } from '../src/record.ts'
import type { ResolvedSpec } from '../src/workflow.ts'

const h = (c: string) => `sha256:${c.repeat(64)}`
const [A, B, V1, V2] = [h('a'), h('b'), h('c'), h('d')]

type Partial_ = { [K in WorkEvent['type']]: Omit<Extract<WorkEvent, { type: K }>, 'seq' | 'at'> }[WorkEvent['type']]
function record(spec: ResolvedSpec, ...events: Partial_[]) {
  const all = [{ type: 'admitted', caller: { type: 'human', operatorId: 'op' }, specId: h('e'), source: { kind: 'direct-task' }, input: h('f') } as Partial_, ...events].map((e, seq) => ({ ...e, seq, at: '2026-11-18T00:00:00Z' }) as WorkEvent)
  return { events: all, state: fold(spec.steps.map((s) => s.id), all) }
}
const spec = (retry: object | undefined, ...more: object[]): ResolvedSpec => ({
  workflow: { id: 'w', version: 1 },
  steps: [
    { id: 'work', capabilities: ['code'], outputs: ['change'], ...(retry ? { retry } : {}) },
    { id: 'check', dependsOn: ['work'], verify: { capability: 'review', subject: '$steps.work.change', criteria: 'ok' } },
    ...more,
  ],
}) as ResolvedSpec

const dispatched = (stepId: string, attemptId = `${stepId}:1`): Partial_ => ({ type: 'dispatched', stepId, attemptId, executor: 'worker', capability: 'code', selected: 'P', candidates: [], inputs: {} }) as Partial_
const observed = (stepId: string, status: 'succeeded' | 'failed', extra: object = {}): Partial_ =>
  ({ type: 'observed', stepId, attemptId: `${stepId}:1`, status, outputs: status === 'succeeded' ? { change: A } : {}, usage: { state: 'unknown' }, ...extra }) as Partial_
const verified = (verdict: 'pass' | 'fail' | 'error' | 'inconclusive', verdictId = V1, subject = A): Partial_ =>
  ({ type: 'verified', stepId: 'check', attemptId: 'check:1', subject, criteria: 'ok', verdict, reason: `it said ${verdict}`, verdictId }) as Partial_
const reopened = (stepId: string, extra: object): Partial_ => ({ type: 'reopened', automatic: true, stepId, reason: 'r', reset: [stepId, 'check'], ...extra }) as Partial_

const built = [dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('fail')]

test('retry: a failed verdict reopens the Worker step with the verdict as `failure` and its change as `previous`', () => {
  const s = spec({ onFail: ['check'], max: 2 })
  const move = retryMove(record(s, ...built), s)
  assert.equal(move?.move, 'reopen')
  assert.deepEqual(move?.event, { type: 'reopened', automatic: true, stepId: 'work', reason: 'check failed: it said fail', failure: V1, previous: A, reset: ['work', 'check'] })
  assert.equal(move?.verdict, undefined)
})

test('retry: no retry rule, a passing verdict or a terminal Work reopens nothing', () => {
  assert.equal(retryMove(record(spec(undefined), ...built), spec(undefined)), undefined)
  const s = spec({ onFail: ['check'], max: 2 })
  assert.equal(retryMove(record(s, dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('pass')), s), undefined)
  assert.equal(retryMove(record(s, ...built, { type: 'terminal', outcome: 'failed', reason: 'x', results: {} } as Partial_), s), undefined)
})

test('retry: `max` reached by earlier automatic reopenings of that verdict stops the retry', () => {
  const s = spec({ onFail: ['check'], max: 1 })
  const earlier = [dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('fail', V2), reopened('work', { failure: V2, previous: A }), dispatched('work', 'work:2'), observed('work', 'succeeded'), dispatched('check', 'check:2'), verified('fail', V1)]
  assert.equal(retryMove(record(s, ...earlier), s), undefined)
  assert.equal(retryMove(record(spec({ onFail: ['check'], max: 2 }), ...earlier), spec({ onFail: ['check'], max: 2 }))?.move, 'reopen')
})

test('retry: a check failing for a step that names it reopens the latest such step, and a verdict about a changed subject is stale', () => {
  const s = spec({ onFail: ['check'], max: 2 }, { id: 'docs', dependsOn: ['work'], capabilities: ['docs'], outputs: ['change'], retry: { onFail: ['check'], max: 2 } })
  const move = retryMove(record(s, ...built, dispatched('docs'), observed('docs', 'succeeded')), s)
  assert.equal(move?.event.stepId, 'docs')
  const stale = record(s, ...built, reopened('work', {}), dispatched('work', 'work:2'), observed('work', 'succeeded', { outputs: { change: B } }))
  assert.equal(retryMove(stale, s), undefined)
})

test('retry: onFail naming several steps reopens the latest in dependency order, with its dependents reset', () => {
  const s = spec({ onFail: ['check'], max: 2 }, { id: 'docs', dependsOn: ['work'], capabilities: ['docs'], outputs: ['change'], retry: { onFail: ['check'], max: 2 } }, { id: 'tail', dependsOn: ['docs'], verify: { capability: 'review', subject: '$steps.docs.change', criteria: 'ok' } })
  const move = retryMove(record(s, ...built, dispatched('docs'), observed('docs', 'succeeded')), s)
  assert.deepEqual(move?.event.reset, ['docs', 'tail'])
})

test('retry: a retryable failure of a step naming itself reopens it without a failure; one the Worker did not mark does not', () => {
  const s = spec({ onFail: ['work'], max: 2 })
  const move = retryMove(record(s, dispatched('work'), observed('work', 'failed', { retryable: true, reason: 'flaked' })), s)
  assert.deepEqual(move?.event, { type: 'reopened', automatic: true, stepId: 'work', reason: 'work failed and may be tried afresh: flaked', reset: ['work', 'check'] })
  assert.equal(retryMove(record(s, dispatched('work'), observed('work', 'failed', { reason: 'flaked' })), s), undefined)
  const used = [dispatched('work'), observed('work', 'failed', { retryable: true }), reopened('work', {}), dispatched('work', 'work:2'), observed('work', 'failed', { retryable: true })]
  assert.equal(retryMove(record(spec({ onFail: ['work'], max: 1 }), ...used), spec({ onFail: ['work'], max: 1 })), undefined)
})

test('retry: a rejected publish reopens the Worker step on the new base with a failing verdict to store; an unknown outcome does not', () => {
  const s = spec({ onFail: ['publish'], max: 2 }, { id: 'publish', dependsOn: ['check'], effect: { capability: 'publish', subject: '$steps.work.change', requires: ['check'] } })
  const base = [dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('pass'), { type: 'effect-intended', stepId: 'publish', operationId: 'op1' } as Partial_]
  const rejected = { type: 'effect-observed', stepId: 'publish', operationId: 'op1', state: 'failed', reason: 'merge conflict with main', rejected: 'conflict', detail: { base: B } } as Partial_
  const move = retryMove(record(s, ...base, rejected), s)
  assert.equal(move?.verdict?.verdict, 'fail')
  assert.deepEqual(move?.verdict?.subject, A)
  assert.equal(move?.event.failedEffect, 'publish')
  assert.equal(move?.event.base, B)
  assert.equal(move?.event.previous, A)
  const unknown = { type: 'effect-observed', stepId: 'publish', operationId: 'op1', state: 'unknown', reason: 'lost' } as Partial_
  assert.equal(retryMove(record(s, ...base, unknown), s), undefined)
})

test('rerunUnchanged: the failing verdict is handed back only when the step opts in and was reopened by that verdict', () => {
  const events = [...built, reopened('work', { failure: V1, previous: A })]
  const without = spec({ onFail: ['check'], max: 2 })
  const withIt = spec({ onFail: ['check'], max: 2, rerunUnchanged: true })
  assert.equal(rerunOf(record(without, ...events), without.steps[0] as never), undefined)
  assert.equal(rerunOf(record(withIt, ...events), withIt.steps[0] as never), V1)
  assert.equal(rerunOf(record(withIt, ...built, reopened('work', {})), withIt.steps[0] as never), undefined, 'a reopening by no verdict')
})

test('next: a failed step fails the Work, once nothing is in flight', () => {
  const s = spec(undefined)
  const r = record(s, dispatched('work'), observed('work', 'failed'))
  assert.deepEqual(nextMove(r, s, false), { move: 'finish', outcome: 'failed', reason: 'step work failed' })
  assert.deepEqual(nextMove(r, s, true), { move: 'wait' })
})

test('next: a step refused by a failing or erroring check stops its dependents; with the attempts in flight it waits', () => {
  const s = spec(undefined, { id: 'publish', dependsOn: ['check'], effect: { capability: 'publish', subject: '$steps.work.change', requires: ['check'] } })
  const r = record(s, dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('error'))
  assert.deepEqual(nextMove(r, s, false), { move: 'finish', outcome: 'failed', reason: 'verification did not pass: check=error' })
  assert.deepEqual(nextMove(r, s, true), { move: 'wait' })
})

test('next: Outside failures in a row at OUTSIDE_HOLD hold the Work; below it the step is dispatched', () => {
  const s = spec(undefined)
  const outside = (n: number) => Array.from({ length: n }, (_, i) => [dispatched('work', `work:${i}`), { type: 'attempt-lost', stepId: 'work', attemptId: `work:${i}`, reason: 'host restart' } as Partial_]).flat()
  const three = record(s, ...outside(3))
  const run = three.state.steps.work!.outside
  assert.equal(run?.count, 3)
  const hold = nextMove(three, s, false)
  assert.equal(hold.move, 'finish')
  assert.equal(hold.move === 'finish' && hold.outcome, 'held')
  assert.equal(hold.move === 'finish' && hold.awaiting, 'work')
  assert.deepEqual(nextMove(three, s, true), { move: 'wait' })
  const two = record(s, ...outside(2))
  assert.equal(nextMove(two, s, false).move, 'dispatch')
})

test('next: ready steps are dispatched in spec order; a step whose `when` output is unwritten is skipped, `unless` when written', () => {
  const s = spec(undefined, { id: 'more', dependsOn: ['work'], when: '$steps.work.extra', capabilities: ['code'], outputs: ['x'] }, { id: 'less', dependsOn: ['work'], unless: '$steps.work.change', capabilities: ['code'], outputs: ['x'] })
  const r = record(s, dispatched('work'), observed('work', 'succeeded'))
  assert.deepEqual(nextMove(r, s, false), { move: 'skip', steps: [{ stepId: 'more', reason: '$steps.work.extra was not written' }, { stepId: 'less', reason: '$steps.work.change was written' }] })
  assert.deepEqual((nextMove(record(spec(undefined), dispatched('work'), observed('work', 'succeeded')), spec(undefined), false) as { steps: { id: string }[] }).steps.map((x) => x.id), ['check'])
})

test('next: a satisfied check skips what follows it; the Work ends Satisfied, with the verdict as evidence', () => {
  const s = spec(undefined, { id: 'publish', dependsOn: ['check'], when: '$steps.work.extra', effect: { capability: 'publish', subject: '$steps.work.change', requires: ['check'] } }, { id: 'accept', dependsOn: ['publish'], accept: { requires: ['check'] } })
  ;(s.steps[1] as { result?: string }).result = 'satisfied'
  const r = record(s, dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('pass'))
  const skip = nextMove(r, s, false)
  assert.deepEqual(skip, { move: 'skip', steps: [{ stepId: 'publish', reason: '$steps.work.extra was not written' }] })
  const after = record(s, dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('pass'), { type: 'skipped', stepId: 'publish', reason: 'x' } as Partial_)
  // `accept` depends on a skipped step, so it is ready; the Work still settles through it.
  const move = nextMove(after, s, false)
  assert.equal(move.move, 'dispatch')
  const sansAccept = { ...s, steps: s.steps.slice(0, 3) } as ResolvedSpec
  const done = nextMove(record(sansAccept, dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('pass'), { type: 'skipped', stepId: 'publish', reason: 'x' } as Partial_), sansAccept, false)
  assert.deepEqual(done, { move: 'finish', outcome: 'succeeded', reason: 'satisfied: check passed', satisfied: { result: 'satisfied', evidence: { 'check.verdict': V1 } } })
})

test('next: with no step left, a missing or failing verdict fails the Work, an inconclusive one holds it for a decision', () => {
  const s = spec(undefined)
  const inconclusive = record(s, dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('inconclusive'))
  assert.deepEqual(nextMove(inconclusive, s, false), { move: 'finish', outcome: 'held', reason: 'inconclusive verification needs an operator decision: check', hold: 'inconclusive' })
  const passed = record(s, dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('pass'))
  assert.deepEqual(nextMove(passed, s, false), { move: 'finish', outcome: 'succeeded', reason: 'every step succeeded' })
  assert.deepEqual(nextMove(passed, s, true), { move: 'wait' })
})

test('accept: passes, fails on a missing verdict, holds for approval and for an inconclusive verdict, and is decided by the operator', () => {
  const accept = { id: 'accept', dependsOn: ['check'], accept: { requires: ['check'] } }
  const s = spec(undefined, accept)
  const ok = [dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('pass')]
  const step = s.steps[2] as Parameters<typeof acceptMove>[2]
  assert.deepEqual(acceptMove(record(s, ...ok), s, step), { move: 'finish', outcome: 'succeeded', reason: 'accepted on check' })
  assert.deepEqual(acceptMove(record(s, dispatched('work'), observed('work', 'succeeded')), s, step), { move: 'finish', outcome: 'failed', reason: 'required verification did not pass: check=missing' })
  const operator = spec(undefined, { ...accept, accept: { requires: ['check'], approval: 'operator' } })
  const opStep = operator.steps[2] as Parameters<typeof acceptMove>[2]
  assert.deepEqual(acceptMove(record(operator, ...ok), operator, opStep), { move: 'finish', outcome: 'held', reason: 'verification passed; awaiting operator approval', awaiting: 'accept', hold: 'approval' })
  const approved = record(operator, ...ok, { type: 'decided', caller: { type: 'human', operatorId: 'op' }, stepId: 'accept', decision: 'approved', reason: 'fine' } as Partial_)
  assert.deepEqual(acceptMove(approved, operator, opStep), { move: 'finish', outcome: 'succeeded', reason: 'accepted by op: fine' })
  const unsure = [dispatched('work'), observed('work', 'succeeded'), dispatched('check'), verified('inconclusive')]
  assert.deepEqual(acceptMove(record(s, ...unsure), s, step), { move: 'finish', outcome: 'held', reason: 'inconclusive verification needs an operator decision: check', awaiting: 'accept', hold: 'inconclusive' })
})
