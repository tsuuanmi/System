/** ms-2: a `confirmation@1` names a stored Artifact the operator confirmed. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Artifacts } from '@system/artifacts'
import { memoryBlobStore, memoryRecordTable } from '../../../test-support/memory.ts'
import { CONFIRMATION_KIND, addConfirmation, confirmationSchema, storedConfirmations } from '../src/confirmation.ts'
import { INTENT_KIND, addIntent, intentSchema } from '../src/intent.ts'

const producer = { type: 'operator' as const, ref: 'tan' }
function store(): Artifacts {
  const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
  artifacts.registerKind({ ...INTENT_KIND, content: intentSchema })
  artifacts.registerKind({ ...CONFIRMATION_KIND, content: confirmationSchema })
  return artifacts
}

test('a confirmation names a stored Artifact, the operator, a date and a note', async () => {
  const artifacts = store()
  const subject = await addIntent(artifacts, { title: 'T', body: 'B' }, producer)
  const now = () => '2026-11-17T10:00:00.000Z'
  const envelope = await addConfirmation(artifacts, { subject: subject.id, note: 'labels checked' }, producer, now)
  assert.equal(envelope.kind, 'confirmation')
  assert.deepEqual(envelope.content, { subject: subject.id, by: 'operator', date: '2026-11-17T10:00:00.000Z', note: 'labels checked' })
  assert.deepEqual(storedConfirmations(artifacts), [{ subject: subject.id, by: 'operator', date: '2026-11-17T10:00:00.000Z', note: 'labels checked' }])
  await assert.rejects(addConfirmation(artifacts, { subject: `sha256:${'0'.repeat(64)}`, note: 'x' }, producer, now), /not a stored Artifact/)
  assert.equal(confirmationSchema.safeParse({ subject: subject.id, by: 'caller', date: '2026-11-17', note: 'x' }).success, false)
})
