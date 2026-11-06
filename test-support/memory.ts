/**
 * In-memory stand-ins for the DSH storage the packages use, shared by every
 * test. Like a DSH table, a write is acknowledged durable first and becomes
 * visible in memory a turn later, so tests catch missing write ordering.
 */
import { createHash } from 'node:crypto'
import { Artifacts, type ArtifactRecord, type BlobStore, type KindSpec, type RecordTable } from '@system/artifacts'
import type { WorkRecord, WorkTable } from '@system/work'

const turn = () => new Promise((resolve) => setImmediate(resolve))

/** Wait for a condition; fail the test instead of hanging. */
export async function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await turn()
  }
}

/** The Artifact record table; `failNextPut` simulates a host lost before a record write. */
export function memoryRecordTable(): RecordTable & { rows: Map<string, ArtifactRecord>; failNextPut: boolean } {
  const rows = new Map<string, ArtifactRecord>()
  const table = {
    rows,
    failNextPut: false,
    get: (key: string) => rows.get(key),
    async put(key: string, value: ArtifactRecord) {
      if (table.failNextPut) {
        table.failNextPut = false
        throw new Error('simulated crash before the record write')
      }
      await turn()
      rows.set(key, structuredClone(value))
    },
    async update(key: string, fn: (current: ArtifactRecord) => ArtifactRecord) {
      const current = rows.get(key)
      if (!current) throw new Error('missing-key')
      const next = fn(structuredClone(current))
      await turn()
      rows.set(key, next)
      return next
    },
  }
  return table
}

/** Content-addressed bytes, like the DSH attachment store. */
export function memoryBlobStore(): BlobStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    async save(data) {
      const attachmentId = `sha256:${createHash('sha256').update(data).digest('hex')}`
      objects.set(attachmentId, data)
      return { attachmentId, bytes: data.byteLength }
    },
    async read({ attachmentId }) {
      return objects.get(attachmentId)
    },
  }
}

/** A real Artifact store over in-memory tables, with the given kinds registered. */
export function memoryArtifacts(...kinds: KindSpec[]): { artifacts: Artifacts; records: ReturnType<typeof memoryRecordTable>; blobs: ReturnType<typeof memoryBlobStore> } {
  const records = memoryRecordTable()
  const blobs = memoryBlobStore()
  const artifacts = new Artifacts(records, blobs)
  for (const kind of kinds) artifacts.registerKind(kind)
  return { artifacts, records, blobs }
}

/**
 * A Work table as one DSH host sees it: a snapshot of `disk` taken when the
 * host opened the store, kept in memory, with writes going to both. Two of
 * them over one `disk` are two processes.
 */
export function snapshotWorkTable(disk: Map<string, WorkRecord>): WorkTable {
  const rows = new Map([...disk].map(([key, value]) => [key, structuredClone(value)]))
  return {
    get: (key) => rows.get(key),
    keys: () => rows.keys(),
    async put(key, value) { await turn(); disk.set(key, structuredClone(value)); rows.set(key, structuredClone(value)) },
    async update(key, fn) {
      const next = fn(structuredClone(rows.get(key)!))
      await turn()
      disk.set(key, structuredClone(next))
      rows.set(key, next)
      return structuredClone(next)
    },
  }
}

/** The Work table: one key per Work. */
export function memoryWorkTable(rows = new Map<string, WorkRecord>()): WorkTable & { rows: Map<string, WorkRecord> } {
  return {
    rows,
    get: (key) => rows.get(key),
    keys: () => rows.keys(),
    async put(key, value) { await turn(); rows.set(key, structuredClone(value)) },
    async update(key, fn) {
      const next = fn(structuredClone(rows.get(key)!))
      await turn()
      rows.set(key, next)
      return structuredClone(next)
    },
  }
}
