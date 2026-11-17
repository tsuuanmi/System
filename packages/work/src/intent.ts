/**
 * `intent@1`: what the operator settled with a caller session, stored before
 * Items carry it out so a result can be traced back to what was wanted.
 */
import { contentIdSchema, type Artifacts, type Envelope } from '@system/artifacts'
import { z } from 'zod'
import { WorkError } from './errors.ts'

export const INTENT_KIND = { kind: 'intent', schemaVersion: 1 } as const
export const intentSchema = z.object({
  title: z.string().min(1).max(200),
  /** Markdown: Outcome, Why, Constraints, Out of scope. */
  body: z.string().min(1).max(64 * 1024),
  /** The earlier `intent@1` Artifact this one replaces (a changed Intent is a new Intent). */
  supersedes: contentIdSchema.optional(),
  /** Set only when the operator settled this Intent in the caller's session (ms-2): it counts as an operator act; an Intent without it is not counted. */
  settledBy: z.literal('operator').optional(),
}).strict()
export type Intent = z.infer<typeof intentSchema>

/** Store an `intent@1`; `supersedes`, when given, must be a stored `intent@1`. */
export async function addIntent(artifacts: Artifacts, intent: Intent, producer: { type: 'operator'; ref: string }): Promise<Envelope> {
  if (intent.supersedes) {
    const read = artifacts.get(intent.supersedes)
    if (read.state !== 'stored') throw new WorkError(`supersedes ${intent.supersedes} is not a stored Artifact`)
    if (read.envelope.kind !== INTENT_KIND.kind || read.envelope.schemaVersion !== INTENT_KIND.schemaVersion) throw new WorkError(`supersedes ${intent.supersedes} is not an intent@1 Artifact`)
  }
  return artifacts.put({
    ...INTENT_KIND, content: intent,
    ...(intent.supersedes ? { supersedes: [intent.supersedes] } : {}),
    classification: 'local-private', producer,
  })
}

/** Every stored `intent@1`: when it was stored and whether the operator settled it, for `rangeReport`. */
export function storedIntents(artifacts: Artifacts): { at: string; settledBy?: 'operator' }[] {
  const found: { at: string; settledBy?: 'operator' }[] = []
  for (const id of artifacts.idsByPrefix(INTENT_KIND.kind, '')) {
    const read = artifacts.get(id)
    if (read.state !== 'stored') continue
    const { settledBy } = read.envelope.content as Intent
    found.push({ at: read.envelope.createdAt, ...(settledBy ? { settledBy } : {}) })
  }
  return found
}
