import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import type { Ask } from '@system/agents'
import type { WorkRecord } from '@system/work'
import { DEFAULT_DIRECTORY, evaluate, formatReport, gate, loadQuestions, wilson, type EvalReport, type LabelledSet } from '../src/index.ts'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, any>
const labelled = fixture('failure-cause-labelled.json')
const set = labelled.set as LabelledSet
const records = fixture('failure-cause-records.json').records as Record<string, WorkRecord>
const question = loadQuestions(DEFAULT_DIRECTORY).find((q) => q.name === 'failure-cause')!

/** A fake Runtime that always gives the same answers in turn. */
const fake = (answers: string[]): Ask => {
  let n = 0
  return async () => ({ ok: true, text: JSON.stringify({ label: answers[n++ % answers.length] }), ref: 'fake/a', runtime: 'fake', runtimeVersion: '1' })
}
const run = (ask: Ask) => evaluate({ set, artifact: labelled.artifact, records, question, ask, artifacts: memoryArtifacts().artifacts })

test('the fixture is the confirmed set: 41 items, its Artifact ID in the header, a record for every Work', () => {
  assert.match(labelled.artifact, /^sha256:a8ad435e/)
  assert.equal(set.items.length, 41)
  for (const item of set.items) assert.ok(records[item.work], item.work)
})

test('a fake Classifier that always says change: the confusion matrix has the set\'s counts in its change column', async () => {
  const report = await run(fake(['change']))
  assert.equal(report.items, 41)
  assert.deepEqual(report.classifier.confusion, {
    change: { change: 22 }, process: { change: 9 }, flaky: { change: 6 }, conflict: { change: 2 }, attach: { change: 1 }, quota: { change: 1 },
  })
  assert.equal(report.classifier.correct, 22)
  assert.equal(report.classifier.unknownRate, 0)
  assert.equal(report.classifier.changeToOutside, 0)
  assert.equal(report.disagreement.items, 0)
})

test('the rules-only accuracy on the 41 items is computed and in the result; the hybrid is the rules unless unknown', async () => {
  const report = await run(fake(['change']))
  assert.equal(report.rules.total, 41)
  assert.equal(report.rules.correct, 24)
  assert.equal(report.rules.unknownRate, 5 / 41)
  assert.match(formatReport(report), /rules\s+24\/41 = 58\.5% \(95% 43\.4%–72\.2%\)/)
  assert.match(formatReport(report), /gate: pass/)
  assert.equal(report.rules.correct, diagonal(report.rules.confusion))
  assert.equal(report.rules.accuracy, report.rules.correct / 41)
  assert.ok(report.rules.interval[0] < report.rules.accuracy && report.rules.accuracy < report.rules.interval[1])
  // Every rules `unknown` goes to the Classifier (always change here); the rest keep the rules' class.
  const unknownAsChange = Object.entries(report.rules.confusion).reduce((n, [gold, row]) => n + (gold === 'change' ? (row.unknown ?? 0) : 0), 0)
  assert.equal(report.hybrid.correct, report.rules.correct + unknownAsChange)
  assert.ok(report.hybrid.accuracy >= report.rules.accuracy)
  assert.equal(report.hybrid.unknownRate, 0)
})

test('samples that disagree are counted and sampled', async () => {
  const report = await run(fake(['change', 'quota', 'change']))
  assert.equal(report.disagreement.items, 41)
  assert.deepEqual(report.disagreement.samples[0]!.answers.slice(0, 3), ['change', 'quota', 'change'])
})

test('a failing Runtime leaves the Classifier unanswered: unknown, never a throw', async () => {
  const report = await run(async () => ({ ok: false, reason: 'down' }))
  assert.equal(report.classifier.unknownRate, 1)
  assert.equal(report.unanswered, 41)
})

test('wilson: 95% interval', () => {
  const [lo, hi] = wilson(5, 10)
  assert.ok(Math.abs(lo - 0.2366) < 1e-3 && Math.abs(hi - 0.7634) < 1e-3)
  assert.deepEqual(wilson(0, 0), [0, 1])
})

const diagonal = (confusion: Record<string, Record<string, number>>) => Object.entries(confusion).reduce((n, [gold, row]) => n + (row[gold] ?? 0), 0)

test('the gate on stored reports: passes when the hybrid is as accurate as the rules with no change→Outside error; one such error fails it', () => {
  const stored = fixture('gate-report.json') as { pass: EvalReport; oneChangeToOutside: EvalReport; lessAccurate: EvalReport }
  assert.deepEqual(gate(stored.pass), { pass: true, reasons: [] })
  const failed = gate(stored.oneChangeToOutside)
  assert.equal(failed.pass, false)
  assert.match(failed.reasons.join(), /change→Outside/)
  const worse = gate(stored.lessAccurate)
  assert.equal(worse.pass, false)
  assert.match(worse.reasons.join(), /less accurate/)
})
