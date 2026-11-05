/**
 * Artifact store invariants. Several scenarios adapt System 1's artifact
 * conformance suite (tsuuanmi/system f199a27,
 * packages/ledger-core/conformance/artifacts.ts) to this envelope.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { memoryBlobStore, memoryRecordTable } from '../../../test-support/memory.ts'
import { Artifacts, ArtifactError, type PutContent } from '../src/artifacts.ts'
import { artifactId } from '../src/envelope.ts'

let clock = 0
const now = () => new Date(Date.UTC(2026, 10, 5, 0, 0, clock++)).toISOString()

function store() {
  const records = memoryRecordTable()
  const blobs = memoryBlobStore()
  const artifacts = new Artifacts(records, blobs, now)
  artifacts.registerKind({ kind: 'note', schemaVersion: 1, content: z.object({ text: z.string() }).strict() })
  return { artifacts, records, blobs }
}

const worker = { type: 'worker', ref: 'claude-code' } as const
const note = (text: string, extra: Partial<PutContent> = {}): PutContent => ({
  kind: 'note', schemaVersion: 1, content: { text }, classification: 'public', producer: worker, ...extra,
})

async function refusedWith(code: ArtifactError['code'], run: () => Promise<unknown>) {
  await assert.rejects(run, (error: unknown) => error instanceof ArtifactError && error.code === code)
}

test('the ID comes from canonical content alone, never the producer or the time', async () => {
  const { artifacts } = store()
  const first = await artifacts.put(note('one'))
  const second = await artifacts.put(note('one', { producer: { type: 'worker', ref: 'codex' }, workId: 'work:2', attemptId: 'attempt:9' }))
  assert.equal(second.id, first.id)
  assert.match(first.id, /^sha256:[0-9a-f]{64}$/)
  assert.equal(first.id, artifactId(first))
  // A forged id or time in the input is not a field of the envelope.
  const forged = await artifacts.put({ ...note('one'), id: `sha256:${'f'.repeat(64)}`, createdAt: '2000-01-01T00:00:00.000Z' } as PutContent)
  assert.equal(forged.id, first.id)
  assert.equal(artifacts.get(`sha256:${'f'.repeat(64)}`).state, 'missing')
})

test('each content field changes the ID', async () => {
  const { artifacts } = store()
  artifacts.registerKind({ kind: 'note', schemaVersion: 2, content: z.object({ text: z.string() }).strict() })
  const base = await artifacts.put(note('one'))
  const others = await Promise.all([
    artifacts.put(note('two')),
    artifacts.put(note('one', { schemaVersion: 2 })),
    artifacts.put(note('one', { subject: { type: 'git-tree', ref: 'abc' } })),
    artifacts.put(note('one', { inputs: [base.id] })),
    artifacts.put(note('one', { supersedes: [base.id] })),
  ])
  assert.equal(new Set([base.id, ...others.map((other) => other.id)]).size, 6)
})

test('producer occurrences stay distinct for equal content', async () => {
  const { artifacts } = store()
  const first = await artifacts.put(note('same', { workId: 'work:1', attemptId: 'attempt:1' }))
  await artifacts.put(note('same', { producer: { type: 'worker', ref: 'codex' }, workId: 'work:2', attemptId: 'attempt:2' }))
  const read = artifacts.get(first.id)
  assert.equal(read.state, 'stored')
  if (read.state !== 'stored') return
  assert.deepEqual(read.occurrences.map((o) => [o.producer.ref, o.workId, o.attemptId]), [['claude-code', 'work:1', 'attempt:1'], ['codex', 'work:2', 'attempt:2']])
  assert.notEqual(read.occurrences[0]!.at, read.occurrences[1]!.at)
})

test('inputs are a sorted set: order and duplicates never change the ID', async () => {
  const { artifacts } = store()
  const a = (await artifacts.put(note('a'))).id
  const b = (await artifacts.put(note('b'))).id
  const ab = await artifacts.put(note('derived', { inputs: [a, b] }))
  const ba = await artifacts.put(note('derived', { inputs: [b, a, b] }))
  assert.equal(ba.id, ab.id)
  assert.deepEqual(ab.inputs, [a, b].sort())
})

test('invalid content, unknown kinds and the wrong body form are refused, storing nothing', async () => {
  const { artifacts, records, blobs } = store()
  await refusedWith('invalid-content', () => artifacts.put(note('x', { content: { text: 42 } })))
  await refusedWith('invalid-content', () => artifacts.put(note('x', { content: { text: 'x', extra: true } })))
  await refusedWith('unknown-kind', () => artifacts.put(note('x', { kind: 'no-such-kind' })))
  await refusedWith('unknown-kind', () => artifacts.put(note('x', { schemaVersion: 7 })))
  await refusedWith('invalid-content', () => artifacts.put({ ...note('x'), kind: 'file', content: 'bytes' }))
  await refusedWith('invalid-content', () => artifacts.putBytes({ ...note('x'), data: new Uint8Array([1]), mediaType: 'text/plain' }))
  await refusedWith('too-large', () => artifacts.put(note('x'.repeat(300 * 1024))))
  assert.equal(records.rows.size, 0)
  assert.equal(blobs.objects.size, 0)
})

test('an unknown input or superseded ID is refused, with no orphan blob', async () => {
  const { artifacts, records, blobs } = store()
  const ghost = `sha256:${'a'.repeat(64)}`
  await refusedWith('unknown-input', () => artifacts.put(note('x', { inputs: [ghost] })))
  await refusedWith('unknown-input', () => artifacts.put(note('x', { supersedes: [ghost] })))
  await refusedWith('unknown-input', () => artifacts.put(note('x', { inputs: ['not-an-id'] })))
  await refusedWith('unknown-input', () => artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: new Uint8Array([1]), mediaType: 'text/plain', inputs: [ghost], classification: 'public', producer: worker }))
  assert.equal(records.rows.size, 0)
  assert.equal(blobs.objects.size, 0)
})

test('a derived Artifact is at least as strict as its strictest input', async () => {
  const { artifacts } = store()
  const secret = await artifacts.put(note('secret', { classification: 'local-private' }))
  const derived = await artifacts.put(note('summary', { inputs: [secret.id], classification: 'public' }))
  assert.equal(derived.classification, 'local-private')
})

test('deduplication never relabels: a stricter request is refused, a laxer one keeps the stored label', async () => {
  const { artifacts } = store()
  const shared = await artifacts.put(note('shared', { classification: 'operator-shared' }))
  await refusedWith('stricter-on-dedup', () => artifacts.put(note('shared', { classification: 'local-private' })))
  const laxer = await artifacts.put(note('shared', { classification: 'public' }))
  assert.equal(laxer.classification, 'operator-shared')
  assert.equal(laxer.id, shared.id)
})

test('stored Artifacts are immutable through what readers get back', async () => {
  const { artifacts } = store()
  const stored = await artifacts.put(note('keep'))
  stored.inputs.push('tampered')
  ;(stored.content as { text: string }).text = 'changed'
  const read = artifacts.get(stored.id)
  assert.equal(read.state, 'stored')
  if (read.state !== 'stored') return
  assert.deepEqual(read.envelope.content, { text: 'keep' })
  assert.deepEqual(read.envelope.inputs, [])
  ;(read.envelope.content as { text: string }).text = 'changed again'
  const again = artifacts.get(stored.id)
  assert.deepEqual(again.state === 'stored' && again.envelope.content, { text: 'keep' })
})

test('bytes are stored before their record; a crash between them is repaired by the next put', async () => {
  const { artifacts, records, blobs } = store()
  const file = { kind: 'file', schemaVersion: 1, data: new TextEncoder().encode('patch'), mediaType: 'text/x-diff', classification: 'public', producer: worker } as const
  records.failNextPut = true
  await assert.rejects(() => artifacts.putBytes(file), /simulated crash/)
  assert.equal(records.rows.size, 0, 'no record without committed bytes')
  assert.equal(blobs.objects.size, 1, 'the orphan blob is content-addressed and harmless')
  const stored = await artifacts.putBytes(file)
  assert.equal(blobs.objects.size, 1, 'the retry reuses the same bytes object')
  assert.deepEqual(Buffer.from(await artifacts.readBytes(stored.id)).toString(), 'patch')
  assert.equal(stored.blob?.bytes, 5)
})

test('a record whose bytes are gone reads as unavailable, never as content', async () => {
  const { artifacts, blobs } = store()
  const stored = await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: new Uint8Array([7]), mediaType: 'application/octet-stream', classification: 'public', producer: worker })
  blobs.objects.clear()
  assert.equal(artifacts.get(stored.id).state, 'stored')
  await refusedWith('unavailable', () => artifacts.readBytes(stored.id))
})

test('concurrent puts of equal new content write one record with both occurrences', async () => {
  const { artifacts, records } = store()
  const [a, b] = await Promise.all([artifacts.put(note('race')), artifacts.put(note('race', { attemptId: 'attempt:2' }))])
  assert.equal(a.id, b.id)
  assert.equal(records.rows.size, 1)
  assert.equal(records.rows.get(a.id)?.occurrences.length, 2)
})

test('reads by malformed IDs are refused', () => {
  const { artifacts } = store()
  assert.throws(() => artifacts.get('../../etc/passwd'), ArtifactError)
})
