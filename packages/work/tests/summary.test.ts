import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkEvent, WorkRecord } from '../src/record.ts'
import { summarize } from '../src/summary.ts'

const human = { type: 'human' as const, operatorId: 'tan' }
const agent = { type: 'agent' as const, operatorId: 'tan' }
const id = (c: string) => `sha256:${c.repeat(64)}`

/** An event before it is numbered; distributes over the union so each kind keeps its fields. */
type Unnumbered = WorkEvent extends infer E ? (E extends WorkEvent ? Omit<E, 'seq'> : never) : never

function record(events: Unnumbered[], status: WorkRecord['state']['status'] = 'succeeded'): WorkRecord {
  return {
    id: 'work:1',
    events: events.map((e, seq) => ({ ...e, seq }) as WorkEvent),
    state: { status, specId: id('a'), criteria: {}, steps: {}, effects: {}, results: {} },
  }
}

test('a Work run straight through needs no operator touch; observed usage is summed', () => {
  const summary = summarize(record([
    { type: 'admitted', at: '2026-11-06T00:00:00.000Z', caller: agent, specId: id('a'), source: { kind: 'direct-task' } },
    { type: 'dispatched', at: '2026-11-06T00:00:01.000Z', stepId: 'task', attemptId: 'attempt:1', executor: 'worker', capability: 'code-write', selected: 'w', candidates: [], inputs: {} },
    { type: 'observed', at: '2026-11-06T00:00:09.000Z', stepId: 'task', attemptId: 'attempt:1', status: 'succeeded', outputs: {}, usage: { state: 'observed', inputTokens: 100, outputTokens: 7, source: 's' } },
    { type: 'terminal', at: '2026-11-06T00:00:10.000Z', outcome: 'succeeded', reason: 'ok', results: {} },
  ]))
  assert.deepEqual(summary, {
    id: 'work:1', status: 'succeeded', durationMs: 10_000, attempts: 1, operatorTouches: 0, touches: [],
    usage: { inputTokens: 100, outputTokens: 7, observedAttempts: 1, unknownAttempts: 0 },
  })
})

test('human decisions, retries and cancels are touches; unknown usage is counted apart, never as zero', () => {
  const summary = summarize(record([
    { type: 'admitted', at: '2026-11-06T00:00:00.000Z', caller: human, specId: id('a'), source: { kind: 'direct-task' } },
    { type: 'dispatched', at: '2026-11-06T00:00:01.000Z', stepId: 'task', attemptId: 'attempt:1', executor: 'worker', capability: 'c', selected: 'w', candidates: [], inputs: {} },
    { type: 'observed', at: '2026-11-06T00:00:02.000Z', stepId: 'task', attemptId: 'attempt:1', status: 'cancelled', outputs: {}, usage: { state: 'unknown' } },
    { type: 'terminal', at: '2026-11-06T00:00:03.000Z', outcome: 'cancelled', reason: 'r', results: {}, caller: human },
    { type: 'reopened', at: '2026-11-06T00:00:04.000Z', caller: human, stepId: 'task', reason: 'take over' },
    { type: 'dispatched', at: '2026-11-06T00:00:05.000Z', stepId: 'task', attemptId: 'attempt:2', executor: 'worker', capability: 'c', selected: 'w', candidates: [], inputs: {} },
    { type: 'observed', at: '2026-11-06T00:00:06.000Z', stepId: 'task', attemptId: 'attempt:2', status: 'succeeded', outputs: {}, usage: { state: 'observed', inputTokens: 5, outputTokens: 1, source: 's' } },
    { type: 'terminal', at: '2026-11-06T00:00:07.000Z', outcome: 'held', reason: 'awaits', results: {}, awaiting: 'accept' },
    { type: 'decided', at: '2026-11-06T00:00:08.000Z', caller: human, stepId: 'accept', decision: 'approved', reason: 'ok' },
    { type: 'terminal', at: '2026-11-06T00:00:09.000Z', outcome: 'succeeded', reason: 'ok', results: {} },
  ]))
  assert.equal(summary.attempts, 2)
  assert.equal(summary.operatorTouches, 3)
  assert.deepEqual(summary.touches, ['cancel', 'retry task', 'approved accept'])
  assert.deepEqual(summary.usage, { inputTokens: 5, outputTokens: 1, observedAttempts: 1, unknownAttempts: 1 })
})
