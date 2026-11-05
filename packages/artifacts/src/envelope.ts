/**
 * The Artifact envelope (ADR-0003 decision 4) and its identity rule.
 *
 * Identity, `artifact-id/v1`: the Artifact ID is `hashDomain('system.artifact/v1', …)`
 * over exactly `kind`, `schemaVersion`, `content` or `blob` (its `attachmentId`
 * and `mediaType`), the sorted `inputs`, `subject` and `lineage`. Classification,
 * producer, time and byte count are not part of it.
 */
import { z } from 'zod'
import { CONTENT_ID_RE, hashDomain, type ContentId } from './canonical.ts'

export const ARTIFACT_ID_DOMAIN = 'system.artifact/v1'

/** Inline content above this many canonical UTF-8 bytes must be stored as a blob. */
export const MAX_INLINE_BYTES = 256 * 1024

export const CLASSIFICATIONS = ['public', 'operator-shared', 'local-private'] as const
export type Classification = (typeof CLASSIFICATIONS)[number]
const RANK: Record<Classification, number> = { public: 0, 'operator-shared': 1, 'local-private': 2 }

/** The stricter of two classifications. */
export function stricter(a: Classification, b: Classification): Classification {
  return RANK[b] > RANK[a] ? b : a
}

export function isStricter(a: Classification, than: Classification): boolean {
  return RANK[a] > RANK[than]
}

const contentIdSchema = z.string().regex(CONTENT_ID_RE)

export const blobRefSchema = z.object({
  attachmentId: contentIdSchema,
  bytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
}).strict()

const subjectSchema = z.object({ type: z.string().min(1), ref: z.string().min(1) }).strict()

export const envelopeSchema = z.object({
  id: contentIdSchema,
  kind: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  content: z.unknown().optional(),
  blob: blobRefSchema.optional(),
  inputs: z.array(contentIdSchema),
  subject: subjectSchema.optional(),
  lineage: z.object({ supersedes: z.array(contentIdSchema).optional() }).strict(),
  classification: z.enum(CLASSIFICATIONS),
  createdAt: z.string(),
}).strict()

export const occurrenceSchema = z.object({
  producer: z.object({ type: z.enum(['operator', 'worker', 'verifier', 'system']), ref: z.string().min(1) }).strict(),
  workId: z.string().optional(),
  attemptId: z.string().optional(),
  at: z.string(),
}).strict()

/** The stored record: one key per Artifact ID. */
export const recordSchema = z.object({
  envelope: envelopeSchema,
  occurrences: z.array(occurrenceSchema).min(1),
}).strict()
export type ArtifactRecord = z.infer<typeof recordSchema>
/** Bytes kept in the DSH attachment store. */
export type BlobRef = z.infer<typeof blobRefSchema>
/** The exact external object an Artifact describes, such as a git tree. */
export type Subject = z.infer<typeof subjectSchema>
export type Envelope = z.infer<typeof envelopeSchema>
/** One production event; equal content produced twice has two occurrences. */
export type Occurrence = z.infer<typeof occurrenceSchema>
/** Who produced one occurrence of an Artifact. */
export type Producer = Occurrence['producer']

/** A sorted set of IDs: duplicates dropped, order never changes identity. */
export function idSet(ids: readonly string[] = []): string[] {
  return [...new Set(ids)].sort()
}

/** The identity of an envelope's content fields (`artifact-id/v1`). */
export function artifactId(fields: Pick<Envelope, 'kind' | 'schemaVersion' | 'content' | 'blob' | 'inputs' | 'subject' | 'lineage'>): ContentId {
  return hashDomain(ARTIFACT_ID_DOMAIN, {
    kind: fields.kind,
    schemaVersion: fields.schemaVersion,
    content: fields.content,
    blob: fields.blob && { attachmentId: fields.blob.attachmentId, mediaType: fields.blob.mediaType },
    inputs: fields.inputs,
    subject: fields.subject,
    lineage: fields.lineage.supersedes?.length ? { supersedes: fields.lineage.supersedes } : {},
  })
}
