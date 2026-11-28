import assert from 'node:assert/strict'
import { test } from 'node:test'
import { costCoverage, usageOutcome, usageRecord, usageTotals } from '../src/usage.ts'
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

const day = (d: string, h = '12') => `2026-11-${d}T${h}:00:00.000Z`
const work = (name: string, admittedAt: string, ...attempts: [string, Parameters<typeof usageRecord>[0] | 'unknown'][]): WorkRecord => ({
  id: `work:${name}`,
  events: [
    { type: 'admitted', seq: 0, at: admittedAt, caller: { type: 'agent', operatorId: 't' }, specId: 'x', source: { kind: 'direct-task' } },
    ...attempts.flatMap(([ref, usage], n) => attempt(n, ref.split('/')[0]!, usage === 'unknown' ? { state: 'unknown' } : usageRecord(usage)).map((e) => (e.type === 'dispatched' ? { ...e, selected: ref } : e))),
  ],
} as unknown as WorkRecord)

test('usageTotals: sums over a fixed set of records, in total and per Runtime, Account and local day; no usage is counted apart, never as zero', () => {
  const local = new Date(2026, 10, 20, 12).toISOString()
  const localNext = new Date(2026, 10, 21, 12).toISOString()
  const records = [
    work('a', local, ['claude-code/main', { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 10, outputTokens: 7, costUsd: 1.5, source: 's' }], ['claude-code/main', 'unknown']),
    work('b', localNext, ['codex/alt', { inputTokens: 50, cacheReadTokens: 20, outputTokens: 3, source: 's' }], ['codex/alt', { inputTokens: 9, outputTokens: 1, costUsd: 0.25, source: 's' }]),
  ]
  const t = usageTotals(records)
  assert.deepEqual(t.total, {
    inputTokens: 159, cacheReadTokens: 80, cacheWriteTokens: 10, freshInputTokens: 60, outputTokens: 11, cacheReadShare: 80 / 150, costUsd: 1.75,
    attempts: { known: 1, partial: 2, unavailable: 1 },
  })
  assert.deepEqual(Object.keys(t.byRuntime).sort(), ['claude-code', 'codex'])
  assert.equal(t.byRuntime['claude-code']!.inputTokens, 100)
  assert.deepEqual(t.byRuntime['claude-code']!.attempts, { known: 1, partial: 0, unavailable: 1 })
  assert.equal(t.byRuntime.codex!.cacheReadShare, 20 / 50)
  assert.equal(t.byRuntime.codex!.costUsd, 0.25)
  assert.deepEqual(Object.keys(t.byAccount).sort(), ['claude-code/main', 'codex/alt'])
  assert.equal(t.byAccount['codex/alt']!.outputTokens, 4)
  const days = Object.keys(t.byDay).sort()
  assert.equal(days.length, 2)
  assert.equal(t.byDay[days[0]!]!.inputTokens, 100)
  assert.equal(t.byDay[days[1]!]!.inputTokens, 59)
})

test('usageTotals: nothing observed gives unknown share and no cost, not zero', () => {
  const t = usageTotals([work('c', day('20'), ['codex/alt', 'unknown'])])
  assert.equal(t.total.cacheReadShare, 'unknown')
  assert.equal('costUsd' in t.total, false)
  assert.deepEqual(t.total.attempts, { known: 0, partial: 0, unavailable: 1 })
  assert.equal(usageTotals([]).total.cacheReadShare, 'unknown')
})
