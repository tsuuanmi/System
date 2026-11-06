import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertConsistent, caller, fixture } from '../../../test-support/fixture.ts'
import type { WorkRecord } from '../src/record.ts'

/** The event sequence as `type:stepId` (the terminal as its outcome). */
const shape = (record: WorkRecord) => record.events.map((e) => (e.type === 'terminal' ? `terminal:${e.outcome}` : 'stepId' in e ? `${e.type}:${e.stepId}` : e.type))

test('Brainstorm records its events in dispatch, observe order', async () => {
  const f = fixture()
  const done = await f.controller.run((await f.admit('brainstorm.yaml')).id)
  assert.deepEqual(shape(done), [
    'admitted',
    'dispatched:idea-a', 'observed:idea-a',
    'dispatched:idea-b', 'observed:idea-b',
    'dispatched:synthesis', 'observed:synthesis',
    'terminal:succeeded',
  ])
  assertConsistent(f, done.id)
})

test('Software Engineering records Worker, verifier and effect events in order', async () => {
  const f = fixture()
  const done = await f.controller.run((await f.admit('software-engineering.yaml')).id)
  assert.deepEqual(shape(done), [
    'admitted',
    'dispatched:implement', 'observed:implement',
    'dispatched:checks', 'verified:checks',
    'effect-intended:publish', 'effect-observed:publish',
    'terminal:succeeded',
  ])
  assertConsistent(f, done.id)
})

test('a cancel request while an attempt is held at a barrier is recorded after the attempt', async () => {
  const f = fixture()
  const admitted = await f.admit('brainstorm.yaml')
  f.hold('idea-b')
  const running = f.controller.run(admitted.id)
  await f.arrived('idea-b')
  assert.equal(await f.controller.cancel(admitted.id, { caller, reason: 'stop' }), 'requested')
  f.release('idea-b')
  const done = await running
  assert.deepEqual(shape(done), ['admitted', 'dispatched:idea-a', 'observed:idea-a', 'dispatched:idea-b', 'observed:idea-b', 'terminal:cancelled'])
  assert.deepEqual(f.attempts, ['idea-a', 'idea-b'])
  assertConsistent(f, done.id)
})

for (let seed = 1; seed <= 50; seed++) {
  test(`seed ${seed}: random delays lose and repeat no event, and the record replays`, async () => {
    const f = fixture({ seed })
    const se = await f.admit('software-engineering.yaml')
    const brainstorm = await f.admit('brainstorm.yaml')
    const [a, b] = await Promise.all([f.controller.run(se.id), f.controller.run(brainstorm.id)])
    assert.equal(a.state.status, 'succeeded')
    assert.equal(b.state.status, 'succeeded')
    assert.equal(a.events.length, 8)
    assert.equal(b.events.length, 8)
    assertConsistent(f, a.id)
    assertConsistent(f, b.id)
  })
}
