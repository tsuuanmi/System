import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outsideCause, outsideRun } from '../src/outside.ts'

test('the real reasons of 2026-11-10/11 classify', () => {
  assert.equal(outsideCause('Your workspace is out of credits'), 'quota')
  assert.equal(outsideCause('the host stopped before the attempt reported'), 'restart')
  assert.equal(outsideCause('merge conflict with dev at 1289f26abcde: README.md'), 'conflict')
  assert.equal(outsideCause('the base fails it too (base abc)'), 'load')
  assert.equal(outsideCause('timed out after 300 s'), 'slow-host')
  assert.equal(outsideCause('retried by the operator'), undefined)
  assert.equal(outsideCause('tests failed: 3 assertions'), undefined)
  assert.equal(outsideCause(''), undefined)
})

const at = '2026-11-14T00:00:00Z'
const lost = (stepId = 'task') => ({ type: 'attempt-lost', stepId, attemptId: 'attempt:x', reason: 'the host stopped before the attempt reported' }) as never
const limited = (stepId = 'task') => ({ type: 'observed', stepId, attemptId: 'attempt:x', status: 'failed', outputs: {}, reason: 'out of credits', usage: { state: 'unknown' }, limited: true }) as never
const finished = (status: 'succeeded' | 'failed', stepId = 'task') => ({ type: 'observed', stepId, attemptId: 'attempt:x', status, outputs: {}, usage: { state: 'unknown' } }) as never
const dispatchedEvent = (stepId = 'task') => ({ type: 'dispatched', stepId, attemptId: 'attempt:x' }) as never
const seq = (events: unknown[]) => events.map((e, seq) => ({ ...(e as object), seq, at })) as never

test('outsideRun counts the Outside failures in a row on a step and names the last cause', () => {
  assert.deepEqual(outsideRun(seq([lost(), dispatchedEvent(), lost(), dispatchedEvent(), limited()]), 'task'), { count: 3, cause: 'quota', reason: 'out of credits' })
  assert.equal(outsideRun(seq([lost(), lost()]), 'task').count, 2)
  assert.equal(outsideRun(seq([lost(), lost('other'), lost()]), 'task').count, 2, 'another step does not count or reset')
})

test('an attempt that finishes resets the count, however it ended', () => {
  for (const status of ['succeeded', 'failed'] as const) {
    assert.equal(outsideRun(seq([lost(), lost(), finished(status), lost()]), 'task').count, 1, status)
  }
  assert.equal(outsideRun(seq([lost(), lost(), { type: 'reopened', stepId: 'task', reason: 'retry', reset: ['task'] }, lost()]), 'task').count, 1, 'a human retry starts again')
})

test('the reason of a hold by the count is an Outside failure of its last cause', () => {
  assert.equal(outsideCause('step task held after 3 Outside failures in a row (last cause: restart): the host stopped before the attempt reported'), 'restart')
  assert.equal(outsideCause('step task held after 3 Outside failures in a row (last cause: quota): out of credits'), 'quota')
})
