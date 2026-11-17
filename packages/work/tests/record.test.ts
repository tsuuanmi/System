import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eventSchema, fold, workRecordSchema, type WorkEvent } from '../src/record.ts'

const prefix: WorkEvent[] = [
  { type: 'admitted', seq: 0, at: '2026-11-10T00:00:00Z', caller: { type: 'human', operatorId: 'quota-test' }, specId: `sha256:${'a'.repeat(64)}`, source: { kind: 'direct-task' } },
  { type: 'dispatched', seq: 1, at: '2026-11-10T00:00:01Z', stepId: 'task', attemptId: 'attempt:1', executor: 'worker', capability: 'research', selected: 'P', candidates: [], inputs: {} },
]

test('a limited observation keeps the attempt and folds to pending; plain and old rateLimited failures stay failed', () => {
  const observed = {
    type: 'observed' as const, seq: 2, at: '2026-11-10T00:00:02Z', stepId: 'task', attemptId: 'attempt:1',
    status: 'failed' as const, outputs: {}, usage: { state: 'unknown' as const },
    reason: 'codex/default exit 1: Your workspace is out of credits. Add credits to continue.',
  }
  // Structural extension compiles against the old event union as well.
  const limited = { ...observed, limited: true as const }
  const plain = fold(['task'], [...prefix, observed]).steps.task!
  const legacy = fold(['task'], [...prefix, { ...observed, rateLimited: true }]).steps.task!
  assert.equal(plain.state, 'failed')
  assert.equal(legacy.state, 'failed', 'old records must retain their meaning')
  const pending = fold(['task'], [...prefix, limited]).steps.task!
  assert.equal(pending.state, 'pending')
  assert.deepEqual(pending.attempts, ['attempt:1'])
  assert.deepEqual(pending.outputs, {})
  const parsed = eventSchema.safeParse(limited)
  assert.equal(parsed.success, true, 'limited must survive durable event validation')
  if (parsed.success) assert.equal(Reflect.get(parsed.data, 'limited'), true)
})

const id = (c: string) => `sha256:${c.repeat(64)}`
const at = '2026-11-10T00:00:00Z'
const admitted = (extra: object = {}): WorkEvent => ({ ...(prefix[0] as object), ...extra }) as WorkEvent
const at1 = (events: object[]): WorkEvent[] => events.map((e, i) => ({ seq: i, at, ...e }) as WorkEvent)
const observed = (seq: number, stepId: string, rest: object = {}): object => ({ type: 'observed', stepId, attemptId: `attempt:${seq}`, status: 'succeeded', outputs: {}, usage: { state: 'unknown' }, ...rest })

test('the verifiers pinned at admission are in the state; a record admitted without them has none', () => {
  const pinned = { check: { ref: 'v/default', version: '1' } }
  assert.deepEqual(fold(['task', 'check'], at1([admitted({ verifiers: pinned })])).verifiers, pinned)
  assert.deepEqual(fold(['task', 'check'], at1([admitted()])).verifiers, {})
})

test('a step keeps its latest reopening, and a reset dependent keeps its own earlier one', () => {
  const reopened = (stepId: string, rest: object): object => ({ type: 'reopened', stepId, reason: 'again', reset: ['a', 'b'], ...rest })
  const events = at1([admitted(), reopened('a', { automatic: true, failure: id('f'), previous: id('1') }), reopened('b', { worker: 'W' }), reopened('a', { previous: id('2') })])
  const { steps } = fold(['a', 'b'], events)
  assert.equal(steps.a!.reopening?.previous, id('2'))
  assert.equal(steps.a!.reopening?.automatic, undefined)
  assert.equal(steps.b!.reopening?.worker, 'W')
  assert.equal(fold(['a', 'b'], at1([admitted()])).steps.a!.reopening, undefined)
  assert.equal(fold(['a', 'b'], events.slice(0, 2)).steps.b!.reopening, undefined, 'a reset step is not the step reopened')
})

test('the changed tests of a subject come from its latest observation that names them, else are empty', () => {
  const tests = [{ path: 't.test.ts', change: 'modified', reason: 'why' }]
  const events = at1([admitted(), observed(1, 'task', { outputs: { change: id('c') }, changedTests: tests }), observed(2, 'task', { outputs: { change: id('c') } }), observed(3, 'task', { outputs: { change: id('d') } }), observed(4, 'task', { status: 'failed', outputs: { change: id('e') } })])
  const state = fold(['task'], events)
  assert.deepEqual(state.changedTests?.[id('c')], tests)
  assert.deepEqual(state.changedTests?.[id('d')], [])
  assert.equal(state.changedTests?.[id('e')], undefined)
})

test('an effect held for an Approval is approved only by a decision after the hold', () => {
  const effect = (rest: object): object => ({ type: 'effect-observed', stepId: 'publish', operationId: 'op', state: 'absent', reason: 'held', ...rest })
  const intended = { type: 'effect-intended', stepId: 'publish', operationId: 'op', capability: 'c', subject: id('s'), params: {}, provider: { ref: 'p', version: '1' } }
  const decided = (decision: string): object => ({ type: 'decided', caller: { type: 'human', operatorId: 'o' }, stepId: 'publish', decision, reason: 'r' })
  const run = (...rest: object[]) => fold(['publish'], at1([admitted(), intended, ...rest])).effects.op!
  assert.equal(run(effect({ held: id('m') })).approvedMerge, undefined)
  assert.equal(run(effect({ held: id('m') }), decided('approved')).approvedMerge, id('m'))
  assert.equal(run(effect({ held: id('m') }), decided('approved'), decided('denied')).approvedMerge, undefined)
  assert.equal(run(decided('approved'), effect({ held: id('m') })).approvedMerge, undefined, 'a decision before the hold is not for it')
  assert.equal(run(effect({ held: id('m') }), decided('approved'), effect({ held: id('n') })).approvedMerge, undefined)
})

test('the Outside run of a step is in its state: counted by cause, reset by an attempt that finishes', () => {
  const lost = { type: 'attempt-lost', stepId: 'task', attemptId: 'attempt:1', reason: 'host restart' }
  const limited = observed(2, 'task', { status: 'failed', limited: true, reason: 'out of credits' })
  const attach = observed(3, 'task', { status: 'failed', reason: 'x', cause: 'attach' })
  const events = at1([admitted(), lost, limited])
  assert.deepEqual(fold(['task'], events).steps.task!.outside, { count: 2, cause: 'quota', reason: 'out of credits' })
  assert.deepEqual(fold(['task'], at1([admitted(), lost, attach])).steps.task!.outside, { count: 2, cause: 'attach', reason: 'x' })
  assert.equal(fold(['task'], at1([admitted(), lost, observed(2, 'task')])).steps.task!.outside, undefined)
  assert.equal(fold(['task'], at1([admitted(), lost, { type: 'reopened', stepId: 'task', reason: 'r', reset: ['task'] }])).steps.task!.outside, undefined)
})

test('a record stored before these facts parses with them derived from its events', () => {
  const events = at1([admitted({ verifiers: { check: { ref: 'v', version: '1' } } }), observed(1, 'task', { outputs: { change: id('c') } })])
  const old = { id: 'work:old', events, state: { status: 'running', specId: prefix[0]!.type === 'admitted' ? prefix[0].specId : '', criteria: {}, steps: { task: { state: 'succeeded', attempts: [], outputs: { change: id('c') } }, check: { state: 'pending', attempts: [], outputs: {} } }, effects: {}, results: {} } }
  const parsed = workRecordSchema.parse(old)
  assert.deepEqual(parsed.state, fold(['task', 'check'], events))
  assert.deepEqual(parsed.state.verifiers, { check: { ref: 'v', version: '1' } })
  assert.deepEqual(parsed.state.changedTests?.[id('c')], [])
})
