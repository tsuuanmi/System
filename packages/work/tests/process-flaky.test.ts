/** cls-3: rb-3's two added rules, from the record's structure only (report-only). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkEvent, WorkRecord } from '../src/record.ts'
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
