import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { laterPasses, type WorkRecord } from '@system/work'
import type { Ask } from '@system/agents/contract'
import { createClassifier, failureEvidence, failureText, hashText, parseQuestion } from '../src/index.ts'

const QUESTION = parseQuestion(`
name: demo
version: 2
instructions: Which cause?
labels:
  - { label: quota, description: out of credits }
  - { label: load, description: the host was busy }
  - { label: unknown, description: none of the others }
examples:
  - { input: "You've hit your limit", label: quota }
samples: 3
`)

/** A fake Runtime: answers from a script, records what it was asked. */
function fake(answers: (string | Error)[]): { ask: Ask; asked: { prompt: string; exclude: string[] }[] } {
  const asked: { prompt: string; exclude: string[] }[] = []
  let n = 0
  return {
    asked,
    ask: async (prompt, options) => {
      asked.push({ prompt, exclude: options.exclude })
      const next = answers[n++ % answers.length]!
      if (next instanceof Error) return { ok: false, reason: next.message }
      return { ok: true, text: next, ref: 'codex/e', runtime: 'codex', model: 'gpt-econ', runtimeVersion: 'codex-cli 1.0' }
    },
  }
}
const say = (label: string) => JSON.stringify({ label })

function build(answers: (string | Error)[]) {
  const { artifacts } = memoryArtifacts()
  const index = new Map<string, { artifact: string }>()
  const runtime = fake(answers)
  const classifier = createClassifier({ artifacts, index: { get: (k) => index.get(k), put: async (k, v) => { index.set(k, v) } }, ask: runtime.ask, questions: [QUESTION] })
  return { classifier, runtime, artifacts, index }
}

test('three agreeing answers are recorded once as a classification@1 with the question hash, models and distribution', async () => {
  const { classifier, runtime, artifacts } = build([say('quota')])
  const got = await classifier.classify('demo', 'the account hit its limit', { exclude: ['claude-code/c4'] })
  assert.equal(got?.label, 'quota')
  assert.equal(got?.confidence, 1)
  assert.equal(runtime.asked.length, 3)
  assert.deepEqual(runtime.asked[0]!.exclude, ['claude-code/c4'])
  assert.match(runtime.asked[0]!.prompt, /the account hit its limit/)
  assert.match(runtime.asked[0]!.prompt, /quota: out of credits/)
  const stored = artifacts.get(got!.classification)
  assert.equal(stored.state, 'stored')
  assert.equal((stored as any).envelope.kind, 'classification')
  const content = (stored as any).envelope.content
  assert.equal(content.question.name, 'demo')
  assert.equal(content.question.version, 2)
  assert.match(content.question.hash, /^sha256:[0-9a-f]{64}$/)
  assert.match(content.input, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(content.distribution, { quota: 1 })
  assert.equal(content.disagreement, false)
  assert.deepEqual(content.samples[0], { answer: 'quota', ref: 'codex/e', runtime: 'codex', model: 'gpt-econ', runtimeVersion: 'codex-cli 1.0' })
})

test('a recorded Classification is read, never asked again', async () => {
  const { classifier, runtime } = build([say('load')])
  const first = await classifier.classify('demo', 'busy', { exclude: [] })
  const asked = runtime.asked.length
  const again = await classifier.classify('demo', 'busy', { exclude: [] })
  assert.deepEqual(again, first)
  assert.deepEqual(classifier.lookup('demo', 'busy'), first)
  assert.equal(runtime.asked.length, asked)
  assert.equal(classifier.lookup('demo', 'another reason'), undefined)
})

test('two of three: the label at 0.67; a reply that is not the answer shape or not in the enum counts as unknown', async () => {
  const two = await build([say('load'), say('quota'), say('load')]).classifier.classify('demo', 'x', { exclude: [] })
  assert.deepEqual([two?.label, two?.confidence], ['load', 0.67])
  const off = await build([say('banana'), 'no json at all', say('quota')]).classifier.classify('demo', 'x', { exclude: [] })
  assert.equal(off?.label, 'unknown')
  const fenced = await build(['```json\n{"label":"quota","reason":"hit"}\n```']).classifier.classify('demo', 'x', { exclude: [] })
  assert.equal(fenced?.label, 'quota')
})

test('a Runtime that fails records nothing and never throws, so a later report asks again', async () => {
  const { classifier, index } = build([say('quota'), new Error('out of credits')])
  assert.equal(await classifier.classify('demo', 'x', { exclude: [] }), undefined)
  assert.equal(index.size, 0)
  const throwing = createClassifier({ artifacts: memoryArtifacts().artifacts, index: { get: () => undefined, put: async () => {} }, ask: async () => { throw new Error('boom') }, questions: [QUESTION] })
  assert.equal(await throwing.classify('demo', 'x', { exclude: [] }), undefined)
  assert.equal(await throwing.classify('no-such-question', 'x', { exclude: [] }), undefined)
})

const id = (c: string) => `sha256:${c.repeat(64)}`
function record(): WorkRecord {
  const events = [
    { type: 'admitted', at: '2026-11-17T00:00:00.000Z', caller: { type: 'agent', operatorId: 't' }, specId: id('a'), source: { kind: 'direct-task' } },
    { type: 'dispatched', at: '2026-11-17T00:00:01.000Z', stepId: 'task', attemptId: 'attempt:1', executor: 'worker', capability: 'c', selected: 'claude-code/c4', candidates: [], inputs: {} },
    { type: 'observed', at: '2026-11-17T00:00:02.000Z', stepId: 'task', attemptId: 'attempt:1', status: 'failed', outputs: {}, usage: { state: 'unknown' }, reason: 'claude-code/c4 exit 1: something strange', worker: { ref: 'claude-code/c4', account: 'c4', command: '/c', version: '1' } },
    { type: 'observed', at: '2026-11-17T00:00:03.000Z', stepId: 'task', attemptId: 'attempt:2', status: 'failed', outputs: {}, usage: { state: 'unknown' }, reason: "claude-code/c4 exit 1: out of credits" },
  ].map((e, seq) => ({ ...e, seq }))
  return { id: 'work:1', events, state: { status: 'failed', specId: id('a'), criteria: {}, steps: {}, effects: {}, results: {} } } as unknown as WorkRecord
}

test('classifyFailures asks only for failures whose rules answer unknown, off the Account that failed, and lookup then finds them', async () => {
  const { classifier, runtime } = build([say('load')])
  const r = record()
  await classifier.classifyFailures('demo', r)
  assert.equal(runtime.asked.length, 3, 'one unknown failure, three samples; the quota failure is placed by its rule')
  assert.deepEqual(runtime.asked[0]!.exclude, ['claude-code/c4'])
  const found = classifier.failureLookup('demo')({ event: 'observed#2', kind: 'attempt', reason: 'claude-code/c4 exit 1: something strange' }, r)
  assert.equal(found?.label, 'load')
  assert.equal(classifier.failureLookup('demo')({ event: 'observed#3', kind: 'attempt', reason: "claude-code/c4 exit 1: out of credits" }, r), undefined)
  await classifier.classifyFailures('demo', r)
  assert.equal(runtime.asked.length, 3, 'a second pass reads, never asks')
})

/** A fixture: the change `c` failed unit, the base re-run was inconclusive, the next attempt had the same content and passed. */
function evidenceRecord(): WorkRecord {
  const events = [
    { type: 'admitted', at: '2026-11-17T00:00:00.000Z', caller: { type: 'agent', operatorId: 't' }, specId: id('a'), source: { kind: 'direct-task' } },
    { type: 'verified', at: '2026-11-17T00:00:01.000Z', stepId: 'checks', attemptId: 'attempt:v1', subject: id('c'), criteria: 'c', verdict: 'fail', reason: 'failed: unit: a.test.ts "x": unable to read tree', verdictId: id('1') },
    { type: 'verified', at: '2026-11-17T00:00:02.000Z', stepId: 'checks', attemptId: 'attempt:v2', subject: id('c'), criteria: 'c', verdict: 'inconclusive', reason: 'unit: the base fails it too (base abc)', verdictId: id('2'), rerunOf: id('1') },
    { type: 'observed', at: '2026-11-17T00:00:03.000Z', stepId: 'task', attemptId: 'attempt:2', status: 'failed', outputs: {}, usage: { state: 'unknown' }, reason: 'something odd' },
    { type: 'observed', at: '2026-11-17T00:00:04.000Z', stepId: 'task', attemptId: 'attempt:3', status: 'succeeded', outputs: {}, usage: { state: 'unknown' } },
    { type: 'verified', at: '2026-11-17T00:00:05.000Z', stepId: 'checks', attemptId: 'attempt:v3', subject: id('c'), criteria: 'c', verdict: 'pass', reason: 'passed', verdictId: id('3') },
  ].map((e, seq) => ({ ...e, seq }))
  return { id: 'work:2', events, state: { status: 'succeeded', specId: id('a'), criteria: {}, steps: {}, effects: {}, results: {} } } as unknown as WorkRecord
}

test('the evidence has the checks on the change and the base re-run, whether a later verdict passed the same content, and the next attempt', () => {
  const r = evidenceRecord()
  const text = failureEvidence({ event: 'verified#1', kind: 'verdict', reason: 'failed: unit: a.test.ts "x": unable to read tree' }, r)
  assert.match(text, /failed: unit: a\.test\.ts "x": unable to read tree/)
  assert.match(text, /- checks: inconclusive \(re-run of the same change\) \[includes the base re-run\]: unit: the base fails it too/)
  assert.match(text, /a later verdict passed the same content: yes/)
  assert.equal(text, failureEvidence({ event: 'verified#1', kind: 'verdict', reason: 'failed: unit: a.test.ts "x": unable to read tree' }, evidenceRecord()), 'deterministic')
  const attempt = failureEvidence({ event: 'observed#3', kind: 'attempt', reason: 'something odd' }, r)
  assert.match(attempt, /next attempt of task: succeeded/)
  assert.doesNotMatch(attempt, /later verdict/, 'no change to compare')
})

test('cls-5: the evidence names a later Work where the same change passed the check', () => {
  const failed = evidenceRecord()
  const passed = { ...evidenceRecord(), id: 'work:9', events: [{ ...failed.events[5]!, at: '2026-11-18T00:00:00.000Z', seq: 0 }] } as WorkRecord
  const failure = { event: 'verified#1', kind: 'verdict' as const, reason: 'failed: unit: a.test.ts "x": unable to read tree' }
  const first = { ...failed, events: failed.events.slice(0, 2) } as WorkRecord
  assert.match(failureEvidence(failure, first, laterPasses([first, passed])), /^the same change passed checks later in work:9$/m)
  assert.doesNotMatch(failureEvidence(failure, first), /passed checks later/)
})

test('a failure is classified from its evidence; a version 1 answer recorded from the reason text is still found', async () => {
  const { classifier, runtime, index } = build([say('load')])
  const r = evidenceRecord()
  await classifier.classifyFailures('demo', r) // the attempt failure is unknown by the rules
  assert.match(runtime.asked[0]!.prompt, /next attempt of task: succeeded/)
  const failure = { event: 'observed#3', kind: 'attempt' as const, reason: 'something odd' }
  assert.equal(classifier.failureLookup('demo')(failure, r)?.label, 'load')
  // A version 1 record: keyed by version 1 and the hash of the reason text.
  const value = [...index.values()][0]!
  index.clear()
  index.set(`demo@1:${hashText(failureText(failure))}`, value)
  assert.equal(classifier.failureLookup('demo')(failure, r)?.label, 'load')
})
