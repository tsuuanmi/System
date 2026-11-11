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
    id: 'work:1', status: 'succeeded', durationMs: 10_000, attempts: 1, waitedForSlotMs: 0, rateLimitedAttempts: 0, operatorTouches: 0, touches: [],
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, freshInputTokens: 0, outputTokens: 7, observedAttempts: 1, unsplitAttempts: 1, unknownAttempts: 0 },
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
  assert.deepEqual(summary.usage, { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, freshInputTokens: 0, outputTokens: 1, observedAttempts: 1, unsplitAttempts: 1, unknownAttempts: 1 })
})

test('cache reads and writes are totalled apart; an attempt without the split is unsplit, never zero cache', () => {
  const observed = (n: number, usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens: number }): Unnumbered => ({
    type: 'observed', at: '2026-11-06T00:00:02.000Z', stepId: 'task', attemptId: `attempt:${n}`, status: 'succeeded', outputs: {}, usage: { state: 'observed', source: 's', ...usage },
  })
  const summary = summarize(record([
    { type: 'admitted', at: '2026-11-06T00:00:00.000Z', caller: agent, specId: id('a'), source: { kind: 'direct-task' } },
    observed(1, { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 7 }),
    observed(2, { inputTokens: 50, cacheReadTokens: 20, outputTokens: 3 }),
    observed(3, { inputTokens: 9, outputTokens: 1 }),
    { type: 'terminal', at: '2026-11-06T00:00:03.000Z', outcome: 'succeeded', reason: 'ok', results: {} },
  ]))
  assert.deepEqual(summary.usage, { inputTokens: 159, cacheReadTokens: 80, cacheWriteTokens: 10, freshInputTokens: 60, outputTokens: 11, observedAttempts: 3, unsplitAttempts: 1, unknownAttempts: 0 })
})

test('the cost estimate is totalled over the attempts that report it, and absent when none does', () => {
  const observed = (n: number, costUsd?: number): Unnumbered => ({
    type: 'observed', at: '2026-11-06T00:00:02.000Z', stepId: 'task', attemptId: `attempt:${n}`, status: 'succeeded', outputs: {}, usage: { state: 'observed', inputTokens: 1, outputTokens: 1, source: 's', ...(costUsd === undefined ? {} : { costUsd }) },
  })
  const admitted: Unnumbered = { type: 'admitted', at: '2026-11-06T00:00:00.000Z', caller: agent, specId: id('a'), source: { kind: 'direct-task' } }
  assert.equal(summarize(record([admitted, observed(1, 0.5), observed(2), observed(3, 0.25)])).usage.costUsdEstimate, 0.75)
  assert.equal('costUsdEstimate' in summarize(record([admitted, observed(1)])).usage, false)
})

test('rate-limited attempts and the time waited for a slot are counted', () => {
  const dispatched = (n: number, waitedMs?: number): Unnumbered => ({ type: 'dispatched', at: '2026-11-06T00:00:01.000Z', stepId: 'task', attemptId: `attempt:${n}`, executor: 'worker', capability: 'code-write', selected: 'w', candidates: [], inputs: {}, ...(waitedMs === undefined ? {} : { waitedMs }) })
  const observed = (n: number, rateLimited?: boolean): Unnumbered => ({ type: 'observed', at: '2026-11-06T00:00:02.000Z', stepId: 'task', attemptId: `attempt:${n}`, status: 'failed', outputs: {}, usage: { state: 'unknown' }, ...(rateLimited ? { rateLimited } : {}) })
  const admitted: Unnumbered = { type: 'admitted', at: '2026-11-06T00:00:00.000Z', caller: agent, specId: id('a'), source: { kind: 'direct-task' } }
  const limited = { ...observed(4), limited: true as const }
  const summary = summarize(record([admitted, dispatched(1, 1500), observed(1, true), dispatched(2, 500), observed(2, true), dispatched(3), observed(3), dispatched(4), limited]))
  assert.equal(summary.waitedForSlotMs, 2000)
  assert.equal(summary.rateLimitedAttempts, 3)
  const none = summarize(record([admitted, dispatched(1), observed(1)]))
  assert.deepEqual([none.waitedForSlotMs, none.rateLimitedAttempts], [0, 0])
})

test('an automatic retry is no operator touch', () => {
  const summary = summarize(record([
    { type: 'admitted', at: '2026-11-06T00:00:00.000Z', caller: human, specId: id('a'), source: { kind: 'direct-task' } },
    { type: 'reopened', at: '2026-11-06T00:00:01.000Z', automatic: true, stepId: 'task', reason: 'checks failed' },
  ]))
  assert.deepEqual(summary.touches, [])
})
