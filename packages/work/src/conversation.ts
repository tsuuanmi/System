/**
 * `conversation@1`: a conversation the operator had elsewhere, such as in a
 * web chat product, taken in as Artifacts (PROP-0003). Its parts (an optional
 * prompt, the response, optional attachments) are `file@1` Artifacts; the
 * manifest lists them as inputs, so it can never point at a part that was not
 * stored. The content records only what the operator asserts and the parts:
 * when and by whom it was added are occurrences, so the same files and
 * assertions always give the same ID. System vouches for the bytes, never for
 * where they came from or whether they are true.
 */
import type { Artifacts, Envelope, Producer } from '@system/artifacts'
import { z } from 'zod'

export const CONVERSATION_KIND = { kind: 'conversation', schemaVersion: 1 } as const

export const NOTICE = 'Operator-supplied conversation. System stored these bytes as given and has not verified who wrote them, whether they are complete, or whether they are true.'

const artifactId = z.string().regex(/^sha256:[0-9a-f]{64}$/)

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
    artifact: artifactId,
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

/** Strings that look like credentials; a warning names the kind, never the value. The global form is compiled once, to redact and to find every match. */
const SECRETS = ([
  { name: 'an OpenAI API key', pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'an Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'a GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: 'an AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a Slack token', pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}/ },
  { name: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a password assignment', pattern: /\bpassword\s*[:=]\s*\S{6,}/i },
  { name: 'a credential in a URL', pattern: /[?&;](?:token|key|secret|password|sig|signature)=[^&\s#]{8,}|\/\/[^\s/@?#]+:[^\s/@?#]+@/i },
] satisfies { name: string; pattern: RegExp }[]).map((s) => ({ name: s.name, global: new RegExp(s.pattern.source, `${s.pattern.flags}g`) }))

/** The kinds of secret in `text`, by name. */
function secretsIn(text: string): string[] {
  return SECRETS.filter((s) => { s.global.lastIndex = 0; return s.global.test(text) }).map((s) => s.name)
}

export interface Preview {
  parts: { role: Role; name: string; bytes: number; firstLine: string }[]
  warnings: string[]
}

/** What would be stored, and what looks like a secret in the parts, their names and the assertions, without storing anything. */
export function previewConversation(parts: ConversationParts, asserted: Asserted = {}): Preview {
  const preview: Preview = { parts: [], warnings: [] }
  for (const [i, { role, part }] of rolesOf(parts).entries()) {
    const text = Buffer.from(part.data).toString('utf8')
    const firstLine = SECRETS.reduce((line, s) => line.replace(s.global, '[redacted]'), text.split('\n').find((l) => l.trim()) ?? '')
    const name = SECRETS.reduce((n, s) => n.replace(s.global, '[redacted]'), part.name)
    preview.parts.push({ role, name, bytes: part.data.byteLength, firstLine: firstLine.slice(0, 120) })
    for (const kind of secretsIn(part.name)) preview.warnings.push(`part ${i + 1} name: looks like ${kind}`)
    for (const kind of secretsIn(text)) preview.warnings.push(`${name}: looks like ${kind}`)
  }
  for (const [field, value] of Object.entries(asserted)) {
    for (const kind of secretsIn(Array.isArray(value) ? value.join('\n') : String(value))) preview.warnings.push(`${field}: looks like ${kind}`)
  }
  return preview
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
