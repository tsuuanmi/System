import assert from 'node:assert/strict'
import { test } from 'node:test'
import { costCoverage, usageOutcome, usageRecord } from '../src/usage.ts'
import type { WorkEvent, WorkRecord } from '../src/record.ts'

const counts = { inputTokens: 10, cacheReadTokens: 2, outputTokens: 3, source: 's' }

test('usageRecord: tokens with a cost are known, tokens without a cost or a cache split are partial with the reason, nothing is unavailable', () => {
  assert.deepEqual(usageRecord({ ...counts, costUsd: 1 }), { state: 'observed', ...counts, costUsd: 1, outcome: 'known', origin: 'stream' })
  assert.deepEqual(usageRecord(counts), { state: 'observed', ...counts, outcome: 'partial', reason: 'the Runtime reported no cost', origin: 'stream' })
  const { cacheReadTokens: _, ...unsplit } = counts
  assert.deepEqual(usageRecord({ ...unsplit, costUsd: 1 }), { state: 'observed', ...unsplit, costUsd: 1, outcome: 'partial', reason: 'the Runtime did not split cache use', origin: 'stream' })
  assert.deepEqual(usageRecord(undefined, 'a stopped attempt reports no usage'), { state: 'unknown', outcome: 'unavailable', reason: 'a stopped attempt reports no usage', origin: 'none' })
  assert.deepEqual(usageRecord(undefined), { state: 'unknown', outcome: 'unavailable', reason: 'the Worker reported no usage', origin: 'none' })
})

test('usageOutcome: an old record without an outcome is derived from what it holds', () => {
  assert.deepEqual(usageOutcome({ state: 'unknown' }), { outcome: 'unavailable', reason: 'not recorded', origin: 'none' })
  assert.equal(usageOutcome({ state: 'observed', ...counts, costUsd: 1 }).outcome, 'known')
  assert.equal(usageOutcome({ state: 'observed', ...counts }).outcome, 'partial')
})

const at = '2026-11-26T00:00:00.000Z'
const attempt = (n: number, runtime: string, usage: WorkEvent extends infer E ? (E extends { type: 'observed'; usage: infer U } ? U : never) : never): WorkEvent[] => [
  { type: 'dispatched', seq: 0, at, stepId: 's', attemptId: `a:${n}`, executor: 'worker', capability: 'c', selected: `${runtime}/acct`, candidates: [], inputs: {} },
  { type: 'observed', seq: 0, at, stepId: 's', attemptId: `a:${n}`, status: 'succeeded', outputs: {}, usage },
]

test('costCoverage counts known, partial and unavailable attempts per Runtime, never unknown as zero cost', () => {
  const record = { id: 'work:1', events: [
    ...attempt(1, 'claude-code', usageRecord({ ...counts, costUsd: 1 })), ...attempt(2, 'claude-code', usageRecord(undefined, 'x')), ...attempt(3, 'codex', usageRecord(counts)),
    ...attempt(4, 'codex', { state: 'unknown' }),
  ] } as unknown as WorkRecord
  assert.deepEqual(costCoverage([record]), { 'claude-code': { known: 1, partial: 0, unavailable: 1 }, codex: { known: 0, partial: 1, unavailable: 1 } })
})
