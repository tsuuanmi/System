import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failureClass, parseCheckFailure } from '../src/failure-class.ts'
import { rangeReport } from '../src/measures.ts'
import type { EscapedDefect } from '../src/defect.ts'
import type { WorkEvent, WorkRecord } from '../src/record.ts'

const agent = { type: 'agent' as const, operatorId: 'tan' }
const id = (c: string) => `sha256:${c.repeat(64)}`
type Unnumbered = WorkEvent extends infer E ? (E extends WorkEvent ? Omit<E, 'seq'> : never) : never
const T = (day: string, time = '00:00:00') => `2026-11-${day}T${time}.000Z`

function record(name: string, status: WorkRecord['state']['status'], events: Unnumbered[]): WorkRecord {
  return { id: `work:${name}`, events: events.map((e, seq) => ({ ...e, seq }) as WorkEvent), state: { status, specId: id('a'), criteria: {}, steps: {}, effects: {}, results: {} } }
}
const admitted = (at: string, item?: string): Unnumbered => ({ type: 'admitted', at, caller: agent, specId: id('a'), source: { kind: 'direct-task' }, ...(item ? { item: { id: item, repository: '/r' } } : {}) }) as Unnumbered
const dispatch = (at: string, n: number): Unnumbered => ({ type: 'dispatched', at, stepId: 'task', attemptId: `attempt:${n}`, executor: 'worker', capability: 'c', selected: 'w', candidates: [], inputs: {} })
const observed = (at: string, n: number, usage: { costUsd?: number } | 'unknown', extra: object = {}): Unnumbered => ({
  type: 'observed', at, stepId: 'task', attemptId: `attempt:${n}`, status: 'succeeded', outputs: {},
  usage: usage === 'unknown' ? { state: 'unknown' } : { state: 'observed', inputTokens: 1, outputTokens: 1, source: 's', ...usage }, ...extra,
}) as Unnumbered
const terminal = (at: string, outcome: 'succeeded' | 'failed' | 'held' | 'cancelled', reason = 'r'): Unnumbered => ({ type: 'terminal', at, outcome, reason, results: {} })
const verdictFail = (at: string, reason: string): Unnumbered => ({ type: 'verified', at, stepId: 'checks', verdict: 'fail', reason } as unknown as Unnumbered)
const merged = (r: WorkRecord): WorkRecord => ({ ...r, state: { ...r.state, effects: { e: { state: 'applied', detail: { merged: 'true' } } } as never } })
const summary = (toolShare: number | 'unknown') => ({ runtime: 'claude-code', toolCalls: {}, filesRead: [], filesEdited: [], longest: [], toolSeconds: 1, toolShare, durationMs: 10, numTurns: 1 })

const A = merged(record('a', 'succeeded', [admitted(T('15', '00:00:00'), 'x-1'), dispatch(T('15', '00:00:01'), 1), observed(T('15', '00:00:02'), 1, { costUsd: 1.5 }, { summary: summary(0.2) }), terminal(T('15', '01:00:00'), 'succeeded')]))
const B = record('b', 'failed', [admitted(T('16'), 'x-2'), dispatch(T('16', '00:00:01'), 1), observed(T('16', '00:00:02'), 1, 'unknown'), verdictFail(T('16', '00:00:03'), 'unit failed'), verdictFail(T('16', '00:00:04'), 'quota exceeded'), terminal(T('16', '00:10:00'), 'failed')])
const C = merged(record('c', 'succeeded', [admitted(T('17'), 'x-2'), dispatch(T('17', '00:00:01'), 1), observed(T('17', '00:00:02'), 1, { costUsd: 0.5 }, { summary: summary(0.4) }), verdictFail(T('17', '00:00:03'), 'unit failed'), terminal(T('17', '03:00:00'), 'succeeded')]))
const D = record('d', 'running', [admitted(T('17', '01:00:00'))])
const OLD = record('old', 'succeeded', [admitted(T('10')), terminal(T('10', '00:01:00'), 'succeeded')])

test('the five measures over a range, with their counts', () => {
  const r = rangeReport([C, OLD, D, A, B], { since: '2026-11-15', escaped: 1 })
  assert.equal(r.works, 4)
  assert.deepEqual(r.verifiedSuccessRate, { rate: 2 / 3, accepted: 2, ended: 3 })
  // B fails unit (change-verdict) and quota; C's unit failure recurs, and nothing earlier had it.
  assert.deepEqual(r.recurringFailureRate, { rate: 1 / 3, recurring: 1, failures: 3 })
  assert.deepEqual(r.escapedDefectRate, { rate: 1 / 2, escaped: 1, itemsMerged: 2, source: 'override (--escaped)' })
  assert.deepEqual(r.costPerVerifiedWork, { usd: 1, knownCostUsd: 2, accepted: 2, worksWithUnknownCost: 1 })
  assert.deepEqual(r.timeToVerifiedResolution, { medianMs: (3 * 3600_000 + 3600_000) / 2, p90Ms: 3 * 3600_000, accepted: 2 })
  assert.deepEqual(r.toolSecondsPerSecond, { mean: 0.30000000000000004, attempts: 2 })
})

test('the range bounds are by admission: since inclusive, until exclusive', () => {
  assert.equal(rangeReport([A, B, C, OLD], { since: '2026-11-15', until: '2026-11-17' }).works, 2)
  assert.equal(rangeReport([A, B, C, OLD], { since: '2026-11-16T00:00:00.000Z', until: '2026-11-17T00:00:00.000Z' }).works, 1)
})

test('with nothing to divide by, or no input, a measure is unknown, never zero', () => {
  const empty = rangeReport([OLD], { since: '2026-11-15' })
  assert.equal(empty.works, 0)
  assert.equal(empty.verifiedSuccessRate.rate, 'unknown')
  assert.equal(empty.recurringFailureRate.rate, 'unknown')
  assert.equal(empty.costPerVerifiedWork.usd, 'unknown')
  assert.equal(empty.timeToVerifiedResolution.medianMs, 'unknown')
  assert.equal(empty.toolSecondsPerSecond.mean, 'unknown')
  const noEscaped = rangeReport([A, C], { since: '2026-11-15' })
  assert.deepEqual(noEscaped.escapedDefectRate, { rate: 'unknown', escaped: 'unknown', itemsMerged: 2, source: 'none' })
  const noCost = rangeReport([B], { since: '2026-11-15' })
  assert.equal(noCost.costPerVerifiedWork.usd, 'unknown')
})

const unit = (test: string) => `failed: unit: a.test.ts "${test}": boom`
const attempt = (at: string, n: number, reason: string): Unnumbered => ({ type: 'observed', at, stepId: 'task', attemptId: `attempt:${n}`, status: 'failed', outputs: {}, reason, usage: { state: 'unknown' } }) as Unnumbered

test('a failure of the change is keyed by its check and first failing test', () => {
  assert.deepEqual(parseCheckFailure(unit('x y')), { check: 'unit', test: 'a.test.ts "x y"' })
  assert.deepEqual(parseCheckFailure('failed: smoke: timed out after 600 s while running s.test.ts "w", t.test.ts "v"'), { check: 'smoke', test: 's.test.ts "w"' })
  assert.deepEqual(parseCheckFailure('failed: build (exit 1)'), { check: 'build' })
  assert.equal(parseCheckFailure('unit failed'), undefined)
  assert.equal(failureClass({ kind: 'verdict', reason: unit('x'), outside: 'quota' }), 'quota')
  assert.equal(failureClass({ kind: 'attempt', reason: 'x', unknown: true }), 'unknown')
})

test('the same check on the same test recurs; two tests of one check do not; unknown is counted apart', () => {
  const work = (name: string, day: string, reasons: Unnumbered[]) => record(name, 'failed', [admitted(T(day)), ...reasons, terminal(T(day, '01:00:00'), 'failed')])
  const same = rangeReport([work('p', '15', [verdictFail(T('15', '00:00:01'), unit('t1'))]), work('q', '16', [verdictFail(T('16', '00:00:01'), unit('t1'))])], { since: '2026-11-15' })
  assert.deepEqual(same.recurringFailureRate, { rate: 1 / 2, recurring: 1, failures: 2 })
  const differ = rangeReport([work('p', '15', [verdictFail(T('15', '00:00:01'), unit('t1'))]), work('q', '16', [verdictFail(T('16', '00:00:01'), unit('t2'))])], { since: '2026-11-15' })
  assert.deepEqual(differ.recurringFailureRate, { rate: 0, recurring: 0, failures: 2 })
  const unknown = rangeReport([work('p', '15', [attempt(T('15', '00:00:01'), 1, 'strange')]), work('q', '16', [attempt(T('16', '00:00:01'), 1, 'strange')])], { since: '2026-11-15' })
  assert.equal(unknown.unknownFailures, 2)
  assert.deepEqual(unknown.recurringFailureRate, { rate: 'unknown', recurring: 0, failures: 0 })
})

const human = { type: 'human' as const, operatorId: 'tan' }
const reopenedBy = (at: string, caller: typeof human | typeof agent): Unnumbered => ({ type: 'reopened', at, caller, stepId: 'task', reason: 'again' }) as Unnumbered
const withCommit = (r: WorkRecord, mergeCommit: string): WorkRecord => ({ ...r, state: { ...r.state, effects: { e: { state: 'applied', detail: { merged: 'true', mergeCommit } } } as never } })

test('headline: Items merged per operator touch, touches by human callers only', () => {
  const touched = merged(record('t', 'succeeded', [admitted(T('15'), 'h-1'), reopenedBy(T('15', '00:00:01'), human), reopenedBy(T('15', '00:00:02'), agent), terminal(T('15', '01:00:00'), 'succeeded')]))
  const other = merged(record('u', 'succeeded', [admitted(T('16'), 'h-2'), reopenedBy(T('16', '00:00:01'), human), terminal(T('16', '01:00:00'), 'succeeded')]))
  const r = rangeReport([touched, other], { since: '2026-11-15' })
  assert.deepEqual(r.headline, { itemsMerged: 2, operatorTouches: 2, perTouch: 1 })
  assert.deepEqual(rangeReport([A, C], { since: '2026-11-15' }).headline, { itemsMerged: 2, operatorTouches: 0, perTouch: 'no touches' })
  assert.deepEqual(rangeReport([OLD], { since: '2026-11-15' }).headline, { itemsMerged: 0, operatorTouches: 0, perTouch: 'no touches' })
  assert.equal(JSON.stringify(rangeReport([A], { since: '2026-11-15' }).headline).includes('null'), false)
})

test('recorded defects count in the range of the merged Item, by Item or merge commit, and not outside it', () => {
  const m = withCommit(record('m', 'succeeded', [admitted(T('15'), 'd-1'), terminal(T('15', '01:00:00'), 'succeeded')]), 'abc1234567890')
  const n = merged(record('n', 'succeeded', [admitted(T('16'), 'd-2'), terminal(T('16', '01:00:00'), 'succeeded')]))
  const old = merged(record('o', 'succeeded', [admitted(T('10'), 'd-0'), terminal(T('10', '01:00:00'), 'succeeded')]))
  const defect = (subject: Partial<EscapedDefect>): EscapedDefect => ({ foundBy: 'work:z', reason: 'r', date: '2026-11-17', ...subject }) as EscapedDefect
  const defects = [defect({ commit: 'abc1234' }), defect({ item: 'd-2' }), defect({ item: 'd-2', reason: 'second' }), defect({ item: 'd-0' }), defect({ item: 'd-9' })]
  const r = rangeReport([m, n, old], { since: '2026-11-15', defects })
  assert.deepEqual(r.escapedDefectRate, { rate: 3 / 2, escaped: 3, itemsMerged: 2, source: 'records' })
  assert.deepEqual(rangeReport([m, n, old], { since: '2026-11-15', defects: [] }).escapedDefectRate, { rate: 0, escaped: 0, itemsMerged: 2, source: 'records' })
  assert.equal(rangeReport([m, n, old], { since: '2026-11-10', until: '2026-11-15', defects }).escapedDefectRate.escaped, 1)
})

test('--escaped stays an override that the report labels', () => {
  const r = rangeReport([A], { since: '2026-11-15', escaped: 4, defects: [{ item: 'x-1', foundBy: 'w', reason: 'r', date: '2026-11-17' }] })
  assert.deepEqual(r.escapedDefectRate, { rate: 4, escaped: 4, itemsMerged: 1, source: 'override (--escaped)' })
})
