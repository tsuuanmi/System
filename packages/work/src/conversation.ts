/**
 * `conversation@1`: a conversation held elsewhere, such as in a web chat,
 * stored as a manifest over `file@1` part Artifacts. Contract:
 * docs/architecture/artifact-verification.md.
 */
import { contentIdSchema, type Artifacts, type Envelope, type Producer } from '@system/artifacts'
import { z } from 'zod'

export const CONVERSATION_KIND = { kind: 'conversation', schemaVersion: 1 } as const

export const NOTICE = 'Operator-supplied conversation. System stored these bytes as given and has not verified who wrote them, whether they are complete, or whether they are true.'

export const assertedSchema = z.object({
  provider: z.string().min(1).optional(),
  url: z.string().url().optional(),
  model: z.string().min(1).optional(),
  capturedAt: z.string().min(1).optional(),
  /** How much of the conversation the parts hold, as the operator states it. */
  selection: z.enum(['complete', 'excerpts', 'summary']).optional(),
  /** Context the product used that the parts do not show, such as browsing, memory or deep research. */
  context: z.array(z.string().min(1)).optional(),
}).strict()
export type Asserted = z.infer<typeof assertedSchema>

export const conversationSchema = z.object({
  notice: z.literal(NOTICE),
  asserted: assertedSchema,
  parts: z.array(z.object({
    role: z.enum(['prompt', 'response', 'attachment']),
    name: z.string().min(1),
    artifact: contentIdSchema,
    mediaType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  }).strict()).min(1),
}).strict()
export type Conversation = z.infer<typeof conversationSchema>

export interface Part {
  name: string
  data: Uint8Array
  mediaType: string
}

export interface ConversationParts {
  prompt?: Part
  response: Part
  attachments?: Part[]
}

type Role = Conversation['parts'][number]['role']

function rolesOf(parts: ConversationParts): { role: Role; part: Part }[] {
  return [
    ...(parts.prompt ? [{ role: 'prompt' as const, part: parts.prompt }] : []),
    { role: 'response' as const, part: parts.response },
    ...(parts.attachments ?? []).map((part) => ({ role: 'attachment' as const, part })),
  ]
}

/** Store the parts, then the manifest over them; `supersedes` marks a correction. */
export async function addConversation(artifacts: Artifacts, parts: ConversationParts, asserted: Asserted, options: { producer: Producer; supersedes?: string[] }): Promise<Envelope> {
  const listed: Conversation['parts'] = []
  for (const { role, part } of rolesOf(parts)) {
    const stored = await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: part.data, mediaType: part.mediaType, classification: 'local-private', producer: options.producer })
    listed.push({ role, name: part.name, artifact: stored.id, mediaType: part.mediaType, bytes: part.data.byteLength })
  }
  return artifacts.put({
    ...CONVERSATION_KIND,
    content: { notice: NOTICE, asserted: assertedSchema.parse(asserted), parts: listed },
    inputs: listed.map((p) => p.artifact),
    supersedes: options.supersedes,
    classification: 'local-private',
    producer: options.producer,
  })
}
