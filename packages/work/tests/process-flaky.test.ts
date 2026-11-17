/** cls-3: rb-3's two added rules, from the record's structure only (report-only). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkEvent, WorkRecord } from '../src/record.ts'
import { laterPasses } from '../src/later-pass.ts'
import { summarize } from '../src/summary.ts'

const id = (c: string) => `sha256:${c.repeat(64)}`
type Unnumbered = WorkEvent extends infer E ? (E extends WorkEvent ? Omit<E, 'seq'> : never) : never
const at = '2026-11-17T00:00:00.000Z'
const build = (events: Unnumbered[]): WorkRecord => ({ id: 'work:1', events: events.map((e, seq) => ({ ...e, seq }) as WorkEvent), state: { status: 'failed', specId: id('a'), criteria: {}, steps: {}, effects: {}, results: {} } }) as unknown as WorkRecord
const admitted: Unnumbered = { type: 'admitted', at, caller: { type: 'agent', operatorId: 't' }, specId: id('a'), source: { kind: 'direct-task' } }
const verified = (verdict: 'pass' | 'fail', verdictId: string, subject: string, extra: object = {}): Unnumbered => ({ type: 'verified', at, stepId: 'checks', attemptId: 'attempt:v', subject, criteria: 'c', verdict, reason: verdict === 'fail' ? 'failed: unit: a.test.ts "x": boom' : 'passed', verdictId, ...extra }) as Unnumbered
const reopened: Unnumbered = { type: 'reopened', at, automatic: true, stepId: 'task', reason: 'check failed', failure: id('1'), previous: id('c'), reset: ['task', 'checks'] }
const observed = (reason: string, extra: object = {}): Unnumbered => ({ type: 'observed', at, stepId: 'task', attemptId: 'attempt:2', status: 'failed', outputs: {}, usage: { state: 'unknown' }, reason, ...extra }) as Unnumbered
const NO_CHANGE = 'no change: the working tree is the same as the base commit abc1234'

test('a "no change" after a reopen whose previous change later passed unchanged is a process failure', () => {
  const r = build([admitted, verified('fail', id('1'), id('c')), reopened, observed(NO_CHANGE), verified('pass', id('2'), id('c'))])
  const s = summarize(r)
  const f = s.failures.find((x) => x.kind === 'attempt')!
  assert.equal(f.outside, 'process')
  assert.equal(f.unknown, undefined)
})

test('a "no change" whose previous change never passed, or with no reopen, stays as before', () => {
  const never = summarize(build([admitted, verified('fail', id('1'), id('c')), reopened, observed(NO_CHANGE)]))
  assert.equal(never.failures.find((x) => x.kind === 'attempt')!.unknown, true)
  const other = summarize(build([admitted, observed(NO_CHANGE), verified('pass', id('2'), id('c'))]))
  assert.equal(other.failures[0]!.unknown, true)
  const different = summarize(build([admitted, verified('fail', id('1'), id('c')), reopened, observed(NO_CHANGE), verified('pass', id('2'), id('d'))]))
  assert.equal(different.failures.find((x) => x.kind === 'attempt')!.unknown, true)
})

test('a failed check that passes on the re-run of the same change (rerunUnchanged) is flaky', () => {
  const r = build([admitted, verified('fail', id('1'), id('c')), reopened, observed('no change: ran the check again', { status: 'succeeded', reason: undefined, unchangedAfter: id('1') }), verified('pass', id('2'), id('c'), { rerunOf: id('1') })])
  const s = summarize(r)
  assert.equal(s.failures.length, 1)
  assert.equal(s.failures[0]!.outside, 'flaky')
  assert.equal(s.outsideFailures, 1)
})

test('a check that fails twice is still a failure of the change', () => {
  const r = build([admitted, verified('fail', id('1'), id('c')), verified('fail', id('2'), id('c'), { rerunOf: id('1') })])
  assert.equal(summarize(r).failures[0]!.outside, undefined)
})

// cls-5: the same facts read across Works (the Host's records).
const other = (workId: string, events: Unnumbered[], laterAt: string): WorkRecord => ({ ...build(events.map((e) => ({ ...e, at: laterAt }) as Unnumbered)), id: workId })
const failedWork = (): WorkRecord => build([admitted, verified('fail', id('1'), id('c'))])

test('cls-5: a check that failed on a change whose tree passed the same check in a later Work is flaky', () => {
  const failed = failedWork()
  const passed = other('work:2', [admitted, verified('pass', id('2'), id('c'))], '2026-11-17T01:00:00.000Z')
  assert.equal(summarize(failed).failures[0]!.outside, undefined, 'one record alone: still a failure of the change')
  const s = summarize(failed, undefined, laterPasses([failed, passed]))
  assert.equal(s.failures[0]!.outside, 'flaky')
  assert.equal(s.outsideFailures, 1)
})

test('cls-5: a tree that never passes, passes another check, or passed only before stays a failure of the change', () => {
  const failed = failedWork()
  const otherCheck = other('work:2', [admitted, { ...verified('pass', id('2'), id('c')), stepId: 'lint' } as Unnumbered], '2026-11-17T01:00:00.000Z')
  const earlier = other('work:3', [admitted, verified('pass', id('3'), id('c'))], '2026-11-16T00:00:00.000Z')
  const differentTree = other('work:4', [admitted, verified('pass', id('4'), id('d'))], '2026-11-17T01:00:00.000Z')
  assert.equal(summarize(failed, undefined, laterPasses([failed, otherCheck, earlier, differentTree])).failures[0]!.outside, undefined)
  assert.equal(summarize(failed, undefined, laterPasses([failed])).failures[0]!.outside, undefined)
})

test('cls-5: a "no change" after a reopen whose previous change passed in a later Work is a process failure', () => {
  const r = build([admitted, verified('fail', id('1'), id('c')), reopened, observed(NO_CHANGE)])
  const passed = other('work:2', [admitted, verified('pass', id('2'), id('c'))], '2026-11-17T01:00:00.000Z')
  const attempt = (s: ReturnType<typeof summarize>) => s.failures.find((x) => x.kind === 'attempt')!
  assert.equal(attempt(summarize(r, undefined, laterPasses([r, passed]))).outside, 'process')
  assert.equal(attempt(summarize(r, undefined, laterPasses([r]))).unknown, true)
})
