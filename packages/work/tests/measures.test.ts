import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultChange, failureClass, parseCheckFailure } from '../src/failure-class.ts'
import { rangeReport } from '../src/measures.ts'
import { isCallerRelease, releaseTimes, releasesByMaker } from '../src/releases.ts'
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
  assert.deepEqual(r.costPerVerifiedWork, { usd: 1, knownCostUsd: 2, accepted: 2, acceptedWithKnownCost: 2, worksWithUnknownCost: 1 })
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

const costWork = (id: string, status: 'succeeded' | 'failed', ...costs: ({ costUsd: number } | 'unknown')[]) => record(id, status, [admitted(T('20', '00:00:00')), ...costs.map((c, i) => observed(T('20', `00:00:0${i + 1}`), i + 1, c)), terminal(T('20', '01:00:00'), status)])
const costOf = (...works: WorkRecord[]) => rangeReport(works, { since: '2026-11-15' }).costPerVerifiedWork

test('cost per verified Work is over the Works whose cost is fully known, and says how many', () => {
  // Today's code divides 3 by 3 accepted: 1.0.
  assert.deepEqual(costOf(costWork('k1', 'succeeded', { costUsd: 1 }), costWork('k2', 'succeeded', { costUsd: 2 }), costWork('k3', 'succeeded', 'unknown')),
    { usd: 1.5, knownCostUsd: 3, accepted: 3, acceptedWithKnownCost: 2, worksWithUnknownCost: 1 })
  // A Work with one costed and one uncosted attempt is unknown: its 1 is not in the numerator.
  assert.deepEqual(costOf(costWork('p1', 'succeeded', { costUsd: 1 }, 'unknown'), costWork('p2', 'succeeded', { costUsd: 2 })),
    { usd: 2, knownCostUsd: 2, accepted: 2, acceptedWithKnownCost: 1, worksWithUnknownCost: 1 })
  // A failed Work with known cost is part of what a verified Work costs.
  assert.deepEqual(costOf(costWork('f1', 'failed', { costUsd: 3 }), costWork('f2', 'succeeded', { costUsd: 1 })),
    { usd: 4, knownCostUsd: 4, accepted: 1, acceptedWithKnownCost: 1, worksWithUnknownCost: 0 })
  // No accepted Work with known cost: unknown, even with known cost elsewhere.
  assert.deepEqual(costOf(costWork('u1', 'succeeded', 'unknown'), costWork('u2', 'failed', { costUsd: 3 })),
    { usd: 'unknown', knownCostUsd: 3, accepted: 1, acceptedWithKnownCost: 0, worksWithUnknownCost: 1 })
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

test('a failure of the change is the rules\' default unless it rests on positive evidence (cls-6)', () => {
  assert.equal(defaultChange({ kind: 'verdict', reason: unit('x') }), false, 'a failing test is named')
  assert.equal(defaultChange({ kind: 'verdict', reason: 'failed: unit: x (the base passed on re-run once; the first run failed on both: y)' }), false, 'a base pass is recorded')
  assert.equal(defaultChange({ kind: 'verdict', reason: 'failed: build (exit 1)' }), true)
  assert.equal(defaultChange({ kind: 'attempt', reason: 'no change: the Worker made none' }), true)
  assert.equal(defaultChange({ kind: 'verdict', reason: unit('x'), outside: 'flaky' }), false, 'an Outside cause stands')
  assert.equal(defaultChange({ kind: 'attempt', reason: 'x', unknown: true }), false, 'unknown is asked on its own')
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

test('recurringClasses: classes seen 2+ times, by count, latest example, top 10, unknown as one class', () => {
  const work = (name: string, day: string, reasons: Unnumbered[]) => record(name, 'failed', [admitted(T(day)), ...reasons, terminal(T(day, '01:00:00'), 'failed')])
  const fail = (day: string, t: string) => verdictFail(T(day, '00:00:01'), unit(t))
  const strange = (day: string) => attempt(T(day, '00:00:02'), 1, 'strange')
  const r = rangeReport([work('p', '15', [fail('15', 't1'), fail('15', 't2'), strange('15')]), work('q', '16', [fail('16', 't1'), strange('16')]), work('r', '17', [fail('17', 't1'), fail('17', 't3')])], { since: '2026-11-15' })
  assert.deepEqual(r.recurringClasses, [
    { class: failureClass({ kind: 'verdict', reason: unit('t1') }), count: 3, example: 'work:r' },
    { class: 'unknown', count: 2, example: 'work:q' },
  ])
  assert.deepEqual(rangeReport([A, C], { since: '2026-11-15' }).recurringClasses.length, 0, 'a class seen once is not listed')
  const many = Array.from({ length: 12 }, (_, i) => [work(`m${i}a`, '15', [fail('15', `k${i}`)]), work(`m${i}b`, '16', [fail('16', `k${i}`)])]).flat()
  assert.equal(rangeReport(many, { since: '2026-11-15' }).recurringClasses.length, 10)
})

const human = { type: 'human' as const, operatorId: 'tan' }
const reopenedBy = (at: string, caller: typeof human | typeof agent): Unnumbered => ({ type: 'reopened', at, caller, stepId: 'task', reason: 'again' }) as Unnumbered
const withCommit = (r: WorkRecord, mergeCommit: string): WorkRecord => ({ ...r, state: { ...r.state, effects: { e: { state: 'applied', detail: { merged: 'true', mergeCommit } } } as never } })

test('headline: operator acts are Intents settled, confirmations, releases and human touches; Items merged per act', () => {
  const touched = merged(record('t', 'succeeded', [admitted(T('15'), 'h-1'), reopenedBy(T('15', '00:00:01'), human), reopenedBy(T('15', '00:00:02'), agent), terminal(T('15', '01:00:00'), 'succeeded')]))
  const other = merged(record('u', 'succeeded', [admitted(T('16'), 'h-2'), reopenedBy(T('16', '00:00:01'), human), terminal(T('16', '01:00:00'), 'succeeded')]))
  const intents = [
    { at: T('15', '02:00:00'), settledBy: 'operator' as const },
    { at: T('16', '02:00:00'), settledBy: 'operator' as const },
    { at: T('16', '03:00:00') }, // a caller's Intent the operator did not settle: not counted
    { at: T('10'), settledBy: 'operator' as const }, // before the range
    { at: T('18'), settledBy: 'operator' as const }, // after `until`
  ]
  const confirmations = [{ date: '2026-11-16' }, { date: '2026-11-01' }]
  const releases = [T('15', '05:00:00'), T('17', '05:00:00'), T('09')]
  const r = rangeReport([touched, other], { since: '2026-11-15', until: '2026-11-18', intents, confirmations, releases })
  assert.deepEqual(r.headline, { itemsMerged: 2, parts: { intentsSettled: 2, confirmations: 1, releases: 2, humanTouches: 2 }, operatorActs: 7, itemsPerAct: 2 / 7, releasesByCaller: 0 })
  // The 2026-11-17 case: Items merged with no touches, yet the operator acted.
  const acts = rangeReport([A, C], { since: '2026-11-15', intents: [{ at: T('15'), settledBy: 'operator' }], releases: [T('16')] }).headline
  assert.deepEqual(acts, { itemsMerged: 2, parts: { intentsSettled: 1, confirmations: 0, releases: 1, humanTouches: 0 }, operatorActs: 2, itemsPerAct: 1, releasesByCaller: 0 })
  // An Intent without `settledBy` is not counted; nothing counted gives `no acts`, never Infinity.
  assert.deepEqual(rangeReport([A, C], { since: '2026-11-15', intents: [{ at: T('15') }] }).headline, { itemsMerged: 2, parts: { intentsSettled: 0, confirmations: 0, releases: 0, humanTouches: 0 }, operatorActs: 0, itemsPerAct: 'no acts', releasesByCaller: 0 })
  assert.deepEqual(rangeReport([OLD], { since: '2026-11-15' }).headline, { itemsMerged: 0, parts: { intentsSettled: 0, confirmations: 0, releases: 0, humanTouches: 0 }, operatorActs: 0, itemsPerAct: 'no acts', releasesByCaller: 0 })
  assert.equal(JSON.stringify(rangeReport([A], { since: '2026-11-15' }).headline).includes('null'), false)
})

test('ms-4: a release by a caller is reported apart as releasesByCaller and not counted as an operator act', () => {
  const r = rangeReport([A, C], { since: '2026-11-15', intents: [{ at: T('15'), settledBy: 'operator' }], releases: [T('16')], callerReleases: [T('16', '01:00:00'), T('17'), T('01')] })
  assert.deepEqual(r.headline, { itemsMerged: 2, parts: { intentsSettled: 1, confirmations: 0, releases: 1, humanTouches: 0 }, operatorActs: 2, itemsPerAct: 1, releasesByCaller: 2 })
})

test('ms-4: the releases of 2026-11-26 (#466, #469, #471, #478, #490) are a caller\'s, a pull request before the delegation or an unmarked one is the operator\'s', () => {
  const merge = (n: number, extra = '') => `Merge pull request #${n} from tsuuanmi/dev\n\nRelease: x${extra}`
  for (const n of [466, 469, 471, 478, 490]) assert.equal(isCallerRelease(merge(n)), true, `#${n}`)
  for (const n of [456, 458, 449]) assert.equal(isCallerRelease(merge(n)), false, `#${n}`)
  assert.equal(isCallerRelease(merge(500, '\n\nReleased-By: caller')), true, 'the marker line in the pull request body')
  assert.equal(isCallerRelease(merge(500, ' Released-By: caller')), false, 'the marker is a line of its own')
  const log = [
    ['2026-11-26T10:46:23Z', 'm1 d1', merge(466)], ['2026-11-26T09:19:52Z', 'm2 d2', merge(456)], ['2026-11-26T15:43:46Z', 'm3 d3', merge(490)], ['2026-11-26T14:00:00Z', 'm4 f1', merge(491)],
  ].map(([t, p, m]) => `${t}\x1f${p}\x1f${m}\n\x1e`).join('')
  assert.deepEqual(releasesByMaker(log, new Set(['d1', 'd2', 'd3'])), { operator: ['2026-11-26T09:19:52.000Z'], caller: ['2026-11-26T10:46:23.000Z', '2026-11-26T15:43:46.000Z'] })
})

test('releaseTimes keeps the merges of a fake git log whose second parent is on dev (`%cI %P` per line, blank lines ignored)', () => {
  const log = '2026-11-17T10:00:00+00:00 a1 d1\n\n2026-11-16T09:30:00+02:00 a2 f1\n2026-11-15T09:30:00+00:00 a3 d2\n'
  assert.deepEqual(releaseTimes(log, new Set(['d1', 'd2'])), ['2026-11-17T10:00:00.000Z', '2026-11-15T09:30:00.000Z'])
  assert.deepEqual(releaseTimes(log, new Set()), [])
  assert.deepEqual(releaseTimes('', new Set(['d1'])), [])
})

test('superseded and withdrawn defects are not counted; a supersedes chain resolves to its latest', () => {
  const n = merged(record('n', 'succeeded', [admitted(T('16'), 'd-2'), terminal(T('16', '01:00:00'), 'succeeded')]))
  const d = (id: string, extra: Partial<EscapedDefect> = {}): EscapedDefect & { id: string } => ({ id, item: 'd-2', foundBy: 'w', reason: 'r', date: '2026-11-17', ...extra })
  const count = (defects: (EscapedDefect & { id: string })[], withdrawals: { withdraws: string; reason: string; date: string }[] = []) =>
    rangeReport([n], { since: '2026-11-15', defects, withdrawals }).escapedDefectRate.escaped
  assert.equal(count([d('a'), d('b')]), 2)
  assert.equal(count([d('a'), d('b', { supersedes: 'a' })]), 1, 'a superseded defect is not counted')
  assert.equal(count([d('a'), d('b', { supersedes: 'a' }), d('c', { supersedes: 'b' })]), 1, 'a chain resolves to its latest')
  assert.equal(count([d('a'), d('b')], [{ withdraws: 'a', reason: 'x', date: '2026-11-17' }]), 1, 'a withdrawn defect is not counted')
  assert.equal(count([d('a'), d('b', { supersedes: 'a' })], [{ withdraws: 'b', reason: 'x', date: '2026-11-17' }]), 0, 'withdrawing the latest withdraws the chain')
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

test('ir-6: a flaky failure is keyed by its check and test; two Works failing the same flaky test are one class', () => {
  const fv = (n: string, v: 'fail' | 'pass', reason: string, extra: object = {}): Unnumbered => ({ type: 'verified', at: T('15', '00:00:01'), stepId: 'checks', attemptId: 'a', subject: id('c'), criteria: 'c', verdict: v, reason, verdictId: id(n), ...extra }) as unknown as Unnumbered
  const work = (name: string, day: string, reasons: string[]) => {
    const events: Unnumbered[] = [admitted(T(day))]
    reasons.forEach((reason, i) => events.push(fv(`${name}${i}`, 'fail', reason), fv(`${name}${i}r`, 'pass', 'passed', { rerunOf: id(`${name}${i}`) })))
    return record(name, 'succeeded', [...events, terminal(T(day, '01:00:00'), 'succeeded')])
  }
  const x = 'failed: unit: x.test.ts "name": boom'
  const same = rangeReport([work('1', '15', [x]), work('2', '16', [x])], { since: '2026-11-15' })
  assert.deepEqual(same.recurringClasses, [{ class: 'flaky:unit:x.test.ts "name"', count: 2, example: 'work:2' }])
  const different = rangeReport([work('3', '15', [x]), work('4', '16', ['failed: unit: y.test.ts "other": boom'])], { since: '2026-11-15' })
  assert.deepEqual(different.recurringClasses, [])
  assert.equal(failureClass({ kind: 'verdict', reason: 'failed: unit: x.test.ts "a": b', outside: 'flaky' }), 'flaky:unit:x.test.ts "a"')
  assert.equal(failureClass({ kind: 'verdict', reason: 'failed: unit: it broke', outside: 'flaky' }), 'flaky:unit:')
  assert.equal(failureClass({ kind: 'verdict', reason: 'inconclusive: x', outside: 'flaky' }), 'flaky')
})

test('ct-2: a failed release verdict on a check the Works skip is a late-caught defect', () => {
  const rel = (name: string, reason: string, criteria = 'repo-checks-release-v1') => record(name, 'failed', [admitted(T('18')), { ...verdictFail(T('18', '00:00:03'), reason), criteria } as Unnumbered, terminal(T('18', '00:10:00'), 'failed')])
  const lateChecks = new Set(['upgrade', 'install-guide'])
  const count = (...rs: WorkRecord[]) => rangeReport(rs, { since: '2026-11-15', lateChecks }).lateCaughtDefects
  assert.deepEqual(count(rel('u', 'failed: upgrade (exit 1)')), { count: 1, checks: ['upgrade'] })
  assert.deepEqual(count(rel('n', 'failed: unit (exit 1)')), { count: 0, checks: [] })
  assert.deepEqual(count(rel('p', 'failed: upgrade (exit 1)', 'repo-checks-v2')), { count: 0, checks: [] })
  assert.deepEqual(count(rel('a', 'failed: upgrade (exit 1)'), rel('b', 'failed: install-guide (exit 1)'), rel('c', 'failed: upgrade (exit 1)')), { count: 3, checks: ['install-guide', 'upgrade'] })
  assert.deepEqual(rangeReport([rel('x', 'failed: upgrade (exit 1)')], { since: '2026-11-15' }).lateCaughtDefects, { count: 0, checks: [] })
})

test('costCoverage: attempts with a known, partial and unavailable cost are counted per Runtime, so unknown cost is not read as zero (usage-1)', () => {
  const sel = (r: WorkRecord, runtime: string): WorkRecord => ({ ...r, events: r.events.map((e) => (e.type === 'dispatched' ? { ...e, selected: `${runtime}/a` } : e)) })
  const r = rangeReport([sel(A, 'claude-code'), sel(B, 'codex'), sel(C, 'claude-code')], { since: '2026-11-15' })
  assert.deepEqual(r.costCoverage, { 'claude-code': { known: 0, partial: 2, unavailable: 0 }, codex: { known: 0, partial: 0, unavailable: 1 } })
})

const reopen = (at: string, automatic = true): Unnumbered => ({ type: 'reopened', at, stepId: 'task', reason: 'checks failed', ...(automatic ? { automatic: true } : { caller: { type: 'human', operatorId: 'tan' } }) }) as unknown as Unnumbered

test('reopen rounds (rounds-1): per Work, in total, median and p90 to pass, and Works failed after the cap', async () => {
  const { summarize } = await import('../src/summary.ts')
  const P0 = record('p0', 'succeeded', [admitted(T('20')), terminal(T('20', '01:00:00'), 'succeeded')])
  const P1 = record('p1', 'succeeded', [admitted(T('21')), reopen(T('21', '00:10:00')), terminal(T('21', '01:00:00'), 'succeeded')])
  const P3 = record('p3', 'succeeded', [admitted(T('22')), reopen(T('22', '00:10:00')), reopen(T('22', '00:20:00'), false), reopen(T('22', '00:30:00')), terminal(T('22', '01:00:00'), 'succeeded')])
  const F = record('f', 'failed', [admitted(T('23')), reopen(T('23', '00:10:00')), verdictFail(T('23', '00:20:00'), 'unit failed'), terminal(T('23', '01:00:00'), 'failed')])
  const G = record('g', 'failed', [admitted(T('24')), verdictFail(T('24', '00:20:00'), 'unit failed'), terminal(T('24', '01:00:00'), 'failed')])
  assert.equal(summarize(P1).reopenRounds, 1)
  assert.equal(summarize(P0).reopenRounds, 0)
  const r = rangeReport([P0, P1, P3, F, G], { since: '2026-11-20' }).reopenRounds
  assert.deepEqual(r.perWork, [{ work: 'work:p0', rounds: 0, status: 'succeeded' }, { work: 'work:p1', rounds: 1, status: 'succeeded' }, { work: 'work:p3', rounds: 3, status: 'succeeded' }, { work: 'work:f', rounds: 1, status: 'failed' }, { work: 'work:g', rounds: 0, status: 'failed' }])
  assert.equal(r.total, 5)
  assert.deepEqual({ median: r.medianToPass, p90: r.p90ToPass, passed: r.passed }, { median: 1, p90: 3, passed: 3 })
  assert.deepEqual(r.failedAfterCap, ['work:f'])
  const none = rangeReport([G], { since: '2026-11-20' }).reopenRounds
  assert.deepEqual({ median: none.medianToPass, p90: none.p90ToPass, failed: none.failedAfterCap }, { median: 'unknown', p90: 'unknown', failed: [] })
})

test('relgate-1: releaseViolations are the violations of the range, as merge and paths', () => {
  const v = (at: string, merge: string) => ({ merge, paths: ['workflows/develop.yaml'], at })
  const r = rangeReport([A], { since: '2026-11-15', until: '2026-11-18', violations: [v(T('16'), 'm1'), v(T('09'), 'm0'), v(T('19'), 'm2')] })
  assert.deepEqual(r.releaseViolations, [{ merge: 'm1', paths: ['workflows/develop.yaml'] }])
  assert.deepEqual(rangeReport([A], { since: '2026-11-15' }).releaseViolations, [])
})
