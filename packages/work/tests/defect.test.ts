import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Artifacts } from '@system/artifacts'
import { memoryBlobStore, memoryRecordTable } from '../../../test-support/memory.ts'
import { DEFECT_KIND, WITHDRAWAL_KIND, addDefect, defectSchema, storedDefects, storedWithdrawals, withdrawDefect, withdrawalSchema } from '../src/defect.ts'
import { TASK_KIND, taskSchema } from '../src/kinds.ts'

const producer = { type: 'operator' as const, ref: 'tan' }
const input = { subject: 'ms-1', foundBy: 'w', reason: 'r', date: '2026-11-17' }
const unknown = `sha256:${'0'.repeat(64)}`

function store(): Artifacts {
  const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
  artifacts.registerKind({ ...DEFECT_KIND, content: defectSchema })
  artifacts.registerKind({ ...WITHDRAWAL_KIND, content: withdrawalSchema })
  artifacts.registerKind({ ...TASK_KIND, content: taskSchema })
  return artifacts
}

test('a defect that supersedes names a stored defect; an unknown or non-defect ID is refused', async () => {
  const artifacts = store()
  const first = await addDefect(artifacts, input, producer)
  const second = await addDefect(artifacts, { ...input, subject: 'ms-2', supersedes: first.id }, producer)
  assert.deepEqual(second.lineage, { supersedes: [first.id] })
  assert.equal((second.content as { supersedes: string }).supersedes, first.id)
  assert.deepEqual(storedDefects(artifacts).map((d) => d.id).sort(), [first.id, second.id].sort())
  await assert.rejects(addDefect(artifacts, { ...input, supersedes: unknown }, producer), /supersedes/)
  const task = await artifacts.put({ ...TASK_KIND, content: { instructions: 'x' }, classification: 'local-private', producer })
  await assert.rejects(addDefect(artifacts, { ...input, supersedes: task.id }, producer), /escaped-defect@1/)
})

test('a withdrawal names a stored defect; an unknown or non-defect ID is refused', async () => {
  const artifacts = store()
  const first = await addDefect(artifacts, input, producer)
  const w = await withdrawDefect(artifacts, { withdraws: first.id, reason: 'wrong carrier' }, producer)
  assert.equal(w.kind, 'escaped-defect-withdrawal')
  assert.deepEqual(storedWithdrawals(artifacts).map((x) => x.withdraws), [first.id])
  assert.ok(artifacts.get(first.id).state === 'stored', 'the withdrawn defect stays')
  await assert.rejects(withdrawDefect(artifacts, { withdraws: unknown, reason: 'x' }, producer), /withdraws/)
  const task = await artifacts.put({ ...TASK_KIND, content: { instructions: 'x' }, classification: 'local-private', producer })
  await assert.rejects(withdrawDefect(artifacts, { withdraws: task.id, reason: 'x' }, producer), /escaped-defect@1/)
  assert.equal(withdrawalSchema.safeParse({ withdraws: first.id, reason: '', date: '2026-11-17' }).success, false)
})
