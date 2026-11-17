import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Artifacts } from '@system/artifacts'
import { memoryBlobStore, memoryRecordTable } from '../../../test-support/memory.ts'
import { INTENT_KIND, addIntent, intentSchema } from '../src/intent.ts'
import { TASK_KIND, taskSchema } from '../src/kinds.ts'

const producer = { type: 'operator' as const, ref: 'tan' }
const body = '## Outcome\nA\n\n## Why\nB\n\n## Constraints\nC\n\n## Out of scope\nD\n'

function store(): Artifacts {
  const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
  artifacts.registerKind({ ...INTENT_KIND, content: intentSchema })
  artifacts.registerKind({ ...TASK_KIND, content: taskSchema })
  return artifacts
}

test('an intent has a title and a body; supersedes is optional', async () => {
  const artifacts = store()
  const envelope = await addIntent(artifacts, { title: 'Say what is wanted', body }, producer)
  assert.equal(envelope.kind, 'intent')
  assert.equal(envelope.schemaVersion, 1)
  assert.deepEqual(envelope.content, { title: 'Say what is wanted', body })
  const read = artifacts.get(envelope.id)
  assert.ok(read.state === 'stored')
})

test('an intent without a title, or with an empty body, is refused', async () => {
  assert.equal(intentSchema.safeParse({ body }).success, false)
  assert.equal(intentSchema.safeParse({ title: '', body }).success, false)
  assert.equal(intentSchema.safeParse({ title: 'x', body: '' }).success, false)
  assert.equal(intentSchema.safeParse({ title: 'x', body, extra: 1 }).success, false)
  await assert.rejects(addIntent(store(), { title: '', body }, producer))
})

test('a changed intent is a new one that names the earlier one; an unknown or non-intent one is refused', async () => {
  const artifacts = store()
  const first = await addIntent(artifacts, { title: 'One', body }, producer)
  const second = await addIntent(artifacts, { title: 'Two', body, supersedes: first.id }, producer)
  assert.notEqual(second.id, first.id)
  assert.equal((second.content as { supersedes: string }).supersedes, first.id)
  assert.ok(artifacts.get(first.id).state === 'stored', 'the earlier intent stays')
  await assert.rejects(addIntent(artifacts, { title: 'Three', body, supersedes: `sha256:${'0'.repeat(64)}` }, producer), /supersedes/)
  const task = await artifacts.put({ ...TASK_KIND, content: { instructions: 'x' }, classification: 'local-private', producer })
  await assert.rejects(addIntent(artifacts, { title: 'Four', body, supersedes: task.id }, producer), /intent@1/)
})
