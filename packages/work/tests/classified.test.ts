/** cls-1: `work report` shows a Classification under its label for a failure whose rules answer `unknown`, marked as classified; nothing else reads it. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkEvent, WorkRecord } from '../src/record.ts'
import { rangeReport } from '../src/measures.ts'
import { summarize, type ClassifiedLookup } from '../src/summary.ts'

const id = (c: string) => `sha256:${c.repeat(64)}`
type Unnumbered = WorkEvent extends infer E ? (E extends WorkEvent ? Omit<E, 'seq'> : never) : never
const at = '2026-11-17T00:00:00.000Z'
function record(workId: string, reasons: string[]): WorkRecord {
  const events: Unnumbered[] = [
    { type: 'admitted', at, caller: { type: 'agent', operatorId: 't' }, specId: id('a'), source: { kind: 'direct-task' } },
    ...reasons.map((reason, n): Unnumbered => ({ type: 'observed', at, stepId: 'task', attemptId: `attempt:${n}`, status: 'failed', outputs: {}, usage: { state: 'unknown' }, reason })),
    { type: 'terminal', at, outcome: 'failed', reason: 'x', results: {} },
  ]
  return { id: workId, events: events.map((e, seq) => ({ ...e, seq }) as WorkEvent), state: { status: 'failed', specId: id('a'), criteria: {}, steps: {}, effects: {}, results: {} } } as unknown as WorkRecord
}
const STRANGE = 'claude-code/c4 exit 1: something strange'
const lookup: ClassifiedLookup = (f) => (f.reason === STRANGE ? { label: 'load', confidence: 0.67, classification: id('c') } : undefined)

test('an unknown failure with a Classification is reported under its label, marked as classified; counts and rule classes are unchanged', () => {
  const r = record('work:1', [STRANGE, "claude-code/c4 exit 1: You've hit your limit"])
  const plain = summarize(r)
  const shown = summarize(r, lookup)
  assert.deepEqual(shown.failures[0], { event: 'observed#1', kind: 'attempt', reason: STRANGE, unknown: true, classified: { label: 'load', confidence: 0.67, classification: id('c') } })
  assert.deepEqual(shown.failures[1], plain.failures[1], 'a failure the rules place is never classified')
  assert.deepEqual(shown.classifiedFailures, { load: 1 })
  assert.deepEqual([shown.unknownFailures, shown.outsideFailures, shown.changeFailures], [plain.unknownFailures, plain.outsideFailures, plain.changeFailures])
})

test('without a lookup, or without a Classification for it, the report is as before', () => {
  const r = record('work:1', [STRANGE])
  assert.deepEqual(summarize(r, () => undefined), summarize(r))
  assert.equal('classifiedFailures' in summarize(r), false)
  assert.equal('classified' in summarize(r).failures[0]!, false)
})

test('the range report tells the classified unknown failures apart, and leaves every measure as it was', () => {
  const works = [record('work:1', [STRANGE]), record('work:2', [STRANGE, 'another strange'])]
  const plain = rangeReport(works, { since: '2026-11-17' })
  const shown = rangeReport(works, { since: '2026-11-17', classified: lookup })
  assert.deepEqual(shown.classifiedUnknownFailures, { load: 2 })
  const { classifiedUnknownFailures: _, ...rest } = shown
  assert.deepEqual(rest, plain)
  assert.equal('classifiedUnknownFailures' in plain, false)
})
