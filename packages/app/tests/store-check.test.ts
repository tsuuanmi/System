import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import type { WorkRecord } from '@system/work'
import { memoryArtifacts, memoryWorkTable } from '../../../test-support/memory.ts'
import { checkStore, formatStoreReport } from '../src/store-check.ts'

const operator = { type: 'operator', ref: 'tester' } as const
const NOTE = { kind: 'note', schemaVersion: 1, content: z.object({ text: z.string() }).strict() }
const GONE = `sha256:${'0'.repeat(64)}`

const record = (id: string, extra: object[] = []): WorkRecord => ({
  id,
  events: [{ type: 'admitted', seq: 0, at: 'now', caller: { type: 'human', operatorId: 'tester' }, specId: GONE, source: { kind: 'direct-task' } }, ...extra] as WorkRecord['events'],
  state: {} as WorkRecord['state'],
})

test('an event naming an Artifact that is not stored is reported with its Work ID', async () => {
  const { artifacts } = memoryArtifacts(NOTE)
  const spec = await artifacts.put({ kind: 'note', schemaVersion: 1, content: { text: 'spec' }, classification: 'public', producer: operator })
  const works = memoryWorkTable()
  const first = record('work:one')
  first.events[0] = { ...first.events[0]!, specId: spec.id } as never
  works.rows.set('work:one', first)
  works.rows.set('work:two', record('work:two', [{ type: 'terminal', seq: 1, at: 'now', outcome: 'succeeded', reason: 'ok', results: { change: GONE } }]))
  const report = await checkStore({ works, artifacts })
  assert.equal(report.ok, false)
  assert.equal(report.works, 2)
  assert.deepEqual(report.problems.filter((p) => p.includes('work:one')), [])
  assert.ok(report.problems.some((p) => p.includes('work:two') && p.includes(GONE) && /not stored/.test(p)), report.problems.join('\n'))
  assert.match(formatStoreReport(report), /problem: Work work:two: .*not stored/)
})

test('a blob whose bytes are gone, and an inline Artifact whose ID is not its hash, are reported', async () => {
  const { artifacts, records, blobs } = memoryArtifacts(NOTE)
  const file = await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: Buffer.from('bytes'), mediaType: 'text/plain', classification: 'public', producer: operator })
  const note = await artifacts.put({ kind: 'note', schemaVersion: 1, content: { text: 'hello' }, classification: 'public', producer: operator })
  const clean = await checkStore({ works: memoryWorkTable(), artifacts })
  assert.deepEqual([clean.ok, clean.artifacts, clean.blobs, clean.bytes], [true, 2, 1, 5])
  blobs.objects.clear()
  const stored = records.rows.get(note.id)!
  records.rows.set(note.id, { ...stored, envelope: { ...stored.envelope, content: { text: 'changed' } } })
  const report = await checkStore({ works: memoryWorkTable(), artifacts })
  assert.equal(report.problems.length, 2, report.problems.join('\n'))
  assert.ok(report.problems.some((p) => p.includes(file.id)))
  assert.ok(report.problems.some((p) => p.includes(note.id) && /hash/.test(p)))
})

test('a Work record that does not read is reported and the walk goes on', async () => {
  const { artifacts } = memoryArtifacts(NOTE)
  const works = memoryWorkTable()
  works.rows.set('work:ok', record('work:ok'))
  const bad = { keys: () => ['work:bad', 'work:ok'][Symbol.iterator](), get: (key: string) => { if (key === 'work:bad') throw new Error('invalid record'); return works.get(key) } }
  const report = await checkStore({ works: bad, artifacts })
  assert.equal(report.works, 2)
  assert.ok(report.problems.some((p) => p.includes('work:bad') && p.includes('invalid record')))
})
