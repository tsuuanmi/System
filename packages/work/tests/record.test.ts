import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eventSchema, fold, type WorkEvent } from '../src/record.ts'

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
