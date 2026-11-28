/**
 * `intent@1`: what the operator settled with a caller session, stored before
 * Items carry it out so a result can be traced back to what was wanted.
 */
import { contentIdSchema, type Artifacts, type Envelope } from '@system/artifacts/contract'
import { z } from 'zod'
import { requireStored, storedOf } from './stored.ts'

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
  if (intent.supersedes) requireStored(artifacts, intent.supersedes, INTENT_KIND, 'supersedes')
  return artifacts.put({
    ...INTENT_KIND, content: intent,
    ...(intent.supersedes ? { supersedes: [intent.supersedes] } : {}),
    classification: 'local-private', producer,
  })
}

/** Every stored `intent@1`: when it was stored and whether the operator settled it, for `rangeReport`. */
export function storedIntents(artifacts: Artifacts): { at: string; settledBy?: 'operator' }[] {
  return storedOf<Intent>(artifacts, INTENT_KIND.kind).map(({ createdAt, content }) => ({ at: createdAt, ...(content.settledBy ? { settledBy: content.settledBy } : {}) }))
}
