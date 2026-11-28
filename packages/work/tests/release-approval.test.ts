/** rel-2: a `release-approval@1` binds the Operator's approval to one commit. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Artifacts } from '@system/artifacts'
import { memoryBlobStore, memoryRecordTable } from '../../../test-support/memory.ts'
import { RELEASE_APPROVAL_KIND, addReleaseApproval, releaseApprovalSchema, storedReleaseApprovals } from '../src/release-approval.ts'

const producer = { type: 'operator' as const, ref: 'tan' }

test('a release approval stores the commit, the operator and the time; the commit is 7 to 40 hex', async () => {
  const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
  artifacts.registerKind({ ...RELEASE_APPROVAL_KIND, content: releaseApprovalSchema })
  const envelope = await addReleaseApproval(artifacts, { commit: 'ABCDEF1234' }, producer, () => '2026-11-28T10:00:00.000Z')
  assert.equal(envelope.kind, 'release-approval')
  assert.deepEqual(storedReleaseApprovals(artifacts), [{ commit: 'abcdef1234', operator: 'tan', at: '2026-11-28T10:00:00.000Z' }])
  await assert.rejects(addReleaseApproval(artifacts, { commit: 'abc12' }, producer))
  await assert.rejects(addReleaseApproval(artifacts, { commit: 'main' }, producer))
})
