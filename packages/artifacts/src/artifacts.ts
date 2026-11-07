/**
 * The Artifact store: immutable, typed, content-addressed records over a
 * key-value table (DSH storage domain) and a blob store (DSH attachments).
 *
 * Write order: blob bytes first, then the record. A crash between them leaves
 * an unreferenced, content-addressed blob that a later put of the same bytes
 * reuses; nothing ever references a record whose bytes were not committed.
 * The record holds the envelope and every occurrence under one key, so a put
 * is one atomic storage write.
 */
import { CONTENT_ID_RE, canonicalJson } from './canonical.ts'
import {
  MAX_INLINE_BYTES,
  artifactId,
  idSet,
  isStricter,
  stricter,
  type ArtifactRecord,
  type BlobRef,
  type Classification,
  type Envelope,
  type Occurrence,
  type Producer,
  type Subject,
} from './envelope.ts'
import type { ZodType } from 'zod'

/** The subset of a DSH `KvTable` the store uses. */
export interface RecordTable {
  get(key: string): ArtifactRecord | undefined
  keys(): IterableIterator<string>
  put(key: string, value: ArtifactRecord): Promise<void>
  update(key: string, fn: (current: ArtifactRecord) => ArtifactRecord): Promise<ArtifactRecord>
}

/** Content-addressed bytes: the DSH attachment store behind an adapter. */
export interface BlobStore {
  save(data: Uint8Array): Promise<{ attachmentId: string; bytes: number }>
  /** The exact bytes, or `undefined` when they are no longer stored. */
  read(blob: { attachmentId: string; bytes: number }): Promise<Uint8Array | undefined>
}

/** A registered kind: inline content validated by `content`, or bytes when `blob`. */
export type KindSpec =
  | { kind: string; schemaVersion: number; content: ZodType }
  | { kind: string; schemaVersion: number; blob: true }

/** Every Artifact of kind `file` is operator- or Worker-supplied bytes. */
export const FILE_KIND: KindSpec = { kind: 'file', schemaVersion: 1, blob: true }

interface CommonInput {
  kind: string
  schemaVersion: number
  inputs?: string[]
  subject?: Subject
  supersedes?: string[]
  classification: Classification
  producer: Producer
  workId?: string
  attemptId?: string
}

export interface PutContent extends CommonInput {
  content: unknown
}

export interface PutBytes extends CommonInput {
  data: Uint8Array
  mediaType: string
}

export type ReadResult =
  | { state: 'stored'; envelope: Envelope; occurrences: Occurrence[] }
  | { state: 'missing' }

export class ArtifactError extends Error {
  readonly code: 'unknown-kind' | 'invalid-content' | 'unknown-input' | 'too-large' | 'stricter-on-dedup' | 'invalid-id' | 'unavailable'

  constructor(code: ArtifactError['code'], message: string) {
    super(message)
    this.name = 'ArtifactError'
    this.code = code
  }
}

export class Artifacts {
  private readonly kinds = new Map<string, KindSpec>()
  /** Serializes writes per Artifact ID: the existence check and the write are one step. */
  private readonly locks = new Map<string, Promise<unknown>>()

  private readonly records: RecordTable
  private readonly blobs: BlobStore
  private readonly now: () => string

  constructor(records: RecordTable, blobs: BlobStore, now: () => string = () => new Date().toISOString()) {
    this.records = records
    this.blobs = blobs
    this.now = now
    this.registerKind(FILE_KIND)
  }

  registerKind(spec: KindSpec): void {
    const key = `${spec.kind}@${spec.schemaVersion}`
    if (this.kinds.has(key)) throw new TypeError(`kind ${key} is already registered`)
    this.kinds.set(key, spec)
  }

  /** Store inline content; returns the stored envelope (the existing one on deduplication). */
  async put(input: PutContent): Promise<Envelope> {
    const spec = this.spec(input)
    if (!('content' in spec)) throw new ArtifactError('invalid-content', `kind ${input.kind}@${input.schemaVersion} stores bytes: use putBytes`)
    const parsed = spec.content.safeParse(input.content)
    if (!parsed.success) throw new ArtifactError('invalid-content', `content of ${input.kind}@${input.schemaVersion} is invalid: ${parsed.error.message}`)
    const canonical = canonicalJson(parsed.data)
    if (Buffer.byteLength(canonical) > MAX_INLINE_BYTES) {
      throw new ArtifactError('too-large', `inline content is ${Buffer.byteLength(canonical)} bytes; above ${MAX_INLINE_BYTES} store it with putBytes`)
    }
    return this.store(input, { content: JSON.parse(canonical) as unknown })
  }

  /** Store bytes in the blob store, then their record. */
  async putBytes(input: PutBytes): Promise<Envelope> {
    const spec = this.spec(input)
    if (!('blob' in spec)) throw new ArtifactError('invalid-content', `kind ${input.kind}@${input.schemaVersion} stores inline content: use put`)
    this.checkRefs(input)
    const saved = await this.blobs.save(input.data)
    return this.store(input, { blob: { ...saved, mediaType: input.mediaType } })
  }

  /** The record for an ID, read by ID only. */
  get(id: string): ReadResult {
    if (!CONTENT_ID_RE.test(id)) throw new ArtifactError('invalid-id', `not an Artifact ID: ${id}`)
    const record = this.records.get(id)
    // Copies: a caller can never change the stored record through what it reads.
    return record ? { state: 'stored', ...structuredClone(record) } : { state: 'missing' }
  }

  /** The IDs of the Artifacts whose `lineage.supersedes` names `id`, found by reading every record. */
  supersededBy(id: string): string[] {
    const found: string[] = []
    for (const key of this.records.keys()) {
      if (this.records.get(key)?.envelope.lineage.supersedes?.includes(id)) found.push(key)
    }
    return found
  }

  /** Every stored Artifact of `kind`, found by reading every record. */
  ofKind(kind: string): Envelope[] {
    const found: Envelope[] = []
    for (const key of this.records.keys()) {
      const envelope = this.records.get(key)?.envelope
      if (envelope?.kind === kind) found.push(structuredClone(envelope))
    }
    return found
  }

  /** The bytes of a blob Artifact; `unavailable` when the record outlived them. */
  async readBytes(id: string): Promise<Uint8Array> {
    const read = this.get(id)
    if (read.state === 'missing') throw new ArtifactError('unknown-input', `no Artifact ${id}`)
    const blob = read.envelope.blob
    if (!blob) throw new ArtifactError('invalid-content', `Artifact ${id} has inline content, not bytes`)
    const data = await this.blobs.read(blob)
    if (data === undefined) throw new ArtifactError('unavailable', `the bytes of Artifact ${id} (${blob.attachmentId}) are no longer stored`)
    return data
  }

  private spec(input: CommonInput): KindSpec {
    const spec = this.kinds.get(`${input.kind}@${input.schemaVersion}`)
    if (!spec) throw new ArtifactError('unknown-kind', `unknown kind ${input.kind}@${input.schemaVersion}`)
    return spec
  }

  /** Every input and superseded ID must already be stored; returns their strictest classification. */
  private checkRefs(input: CommonInput): Classification {
    let floor: Classification = 'public'
    for (const ref of [...(input.inputs ?? []), ...(input.supersedes ?? [])]) {
      const record = CONTENT_ID_RE.test(ref) ? this.records.get(ref) : undefined
      if (!record) throw new ArtifactError('unknown-input', `input ${ref} is not a stored Artifact`)
      floor = stricter(floor, record.envelope.classification)
    }
    return floor
  }

  private async store(input: CommonInput, body: { content?: unknown; blob?: BlobRef }): Promise<Envelope> {
    const floor = this.checkRefs(input)
    const fields = {
      kind: input.kind,
      schemaVersion: input.schemaVersion,
      ...body,
      inputs: idSet(input.inputs),
      subject: input.subject,
      lineage: input.supersedes?.length ? { supersedes: idSet(input.supersedes) } : {},
    }
    const id = artifactId(fields)
    const classification = stricter(input.classification, floor)
    const at = this.now()
    const occurrence: Occurrence = { producer: input.producer, workId: input.workId, attemptId: input.attemptId, at }
    return this.locked(id, async () => {
      const existing = this.records.get(id)
      if (existing) {
        // Deduplication never relabels stored content: a stricter request is refused, a laxer one keeps the stored label.
        if (isStricter(classification, existing.envelope.classification)) {
          throw new ArtifactError('stricter-on-dedup', `Artifact ${id} is stored as ${existing.envelope.classification}; refusing ${classification} on deduplication`)
        }
        await this.records.update(id, (current) => ({ ...current, occurrences: [...current.occurrences, occurrence] }))
        return structuredClone(existing.envelope)
      }
      const envelope: Envelope = { id, ...fields, classification, createdAt: at }
      await this.records.put(id, { envelope, occurrences: [occurrence] })
      return structuredClone(envelope)
    })
  }

  private async locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.locks.set(id, next)
    try {
      return await next
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }
  }
}
