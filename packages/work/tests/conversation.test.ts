import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Artifacts } from '@system/artifacts'
import { memoryBlobStore, memoryRecordTable } from '../../../test-support/memory.ts'
import { CONVERSATION_KIND, NOTICE, addConversation, conversationSchema, previewConversation, type ConversationParts } from '../src/conversation.ts'
import { TASK_KIND, taskSchema } from '../src/kinds.ts'

const producer = { type: 'operator' as const, ref: 'tan' }
const bytes = (text: string) => new TextEncoder().encode(text)

function store(): Artifacts {
  const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
  artifacts.registerKind({ ...CONVERSATION_KIND, content: conversationSchema })
  artifacts.registerKind({ ...TASK_KIND, content: taskSchema })
  return artifacts
}

const parts: ConversationParts = {
  prompt: { name: 'prompt.md', data: bytes('Review PR #2.\n'), mediaType: 'text/markdown' },
  response: { name: 'response.md', data: bytes('# Review\nBrainstorm V0 works.\n'), mediaType: 'text/markdown' },
  attachments: [{ name: 'export.json', data: bytes('{"mapping":{}}'), mediaType: 'application/json' }],
}

test('a conversation is a manifest over its stored parts: asserted facts, roles, and the fixed notice', async () => {
  const artifacts = store()
  const manifest = await addConversation(artifacts, parts, { provider: 'ChatGPT', url: 'https://chatgpt.com/c/1', selection: 'complete' }, { producer })
  assert.equal(manifest.kind, 'conversation')
  assert.equal(manifest.classification, 'local-private')
  const content = conversationSchema.parse(manifest.content)
  assert.equal(content.notice, NOTICE)
  assert.deepEqual(content.asserted, { provider: 'ChatGPT', url: 'https://chatgpt.com/c/1', selection: 'complete' })
  assert.deepEqual(content.parts.map((p) => [p.role, p.name, p.bytes]), [['prompt', 'prompt.md', 14], ['response', 'response.md', 30], ['attachment', 'export.json', 14]])
  assert.deepEqual([...manifest.inputs].sort(), content.parts.map((p) => p.artifact).sort())
  const response = content.parts.find((p) => p.role === 'response')!
  assert.equal(Buffer.from(await artifacts.readBytes(response.artifact)).toString(), '# Review\nBrainstorm V0 works.\n')
  const part = artifacts.get(response.artifact)
  assert.equal(part.state === 'stored' && part.envelope.classification, 'local-private')
})

test('the same parts and assertions give the same ID; the time and the operator are occurrences, not content', async () => {
  const artifacts = store()
  const first = await addConversation(artifacts, parts, { provider: 'ChatGPT' }, { producer })
  const again = await addConversation(artifacts, parts, { provider: 'ChatGPT' }, { producer: { type: 'operator', ref: 'someone-else' } })
  assert.equal(again.id, first.id)
  const read = artifacts.get(first.id)
  assert.ok(read.state === 'stored')
  assert.deepEqual(read.occurrences.map((o) => o.producer.ref), ['tan', 'someone-else'])
})

test('only a response is required; unknown assertions are left out, never guessed', async () => {
  const manifest = await addConversation(store(), { response: parts.response }, {}, { producer })
  const content = conversationSchema.parse(manifest.content)
  assert.deepEqual(content.asserted, {})
  assert.deepEqual(content.parts.map((p) => p.role), ['response'])
})

test('a correction supersedes the conversation it corrects', async () => {
  const artifacts = store()
  const first = await addConversation(artifacts, parts, {}, { producer })
  const fixed = await addConversation(artifacts, { ...parts, response: { ...parts.response, data: bytes('# Review\nFixed.\n') } }, {}, { producer, supersedes: [first.id] })
  assert.deepEqual(fixed.lineage, { supersedes: [first.id] })
  await assert.rejects(() => addConversation(artifacts, parts, {}, { producer, supersedes: ['sha256:' + '0'.repeat(64)] }), /not a stored Artifact/)
})

test('the preview stores nothing and names secret-like strings by kind and part, never by value', async () => {
  const leaky: ConversationParts = {
    response: { name: 'response.md', data: bytes('use sk-proj-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123456789\n'), mediaType: 'text/markdown' },
    attachments: [{ name: 'key.pem', data: bytes('-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n'), mediaType: 'text/plain' }],
  }
  const preview = previewConversation(leaky)
  assert.deepEqual(preview.parts.map((p) => [p.role, p.name, p.bytes, p.firstLine]), [['response', 'response.md', 82, 'use [redacted] and [redacted]'], ['attachment', 'key.pem', 40, '[redacted]']])
  assert.deepEqual(preview.warnings, [
    'response.md: looks like an OpenAI API key',
    'response.md: looks like a GitHub token',
    'key.pem: looks like a private key',
  ])
  assert.ok(JSON.stringify(preview).includes('abcdef') === false, 'the preview never repeats a secret')
  assert.deepEqual(previewConversation(parts).warnings, [])
})

test('a Task carries context Artifacts as inputs, so they must be stored and the strictest classification wins', async () => {
  const artifacts = store()
  const conversation = await addConversation(artifacts, parts, {}, { producer })
  const task = await artifacts.put({ ...TASK_KIND, content: { instructions: 'Use the review.', context: [conversation.id] }, inputs: [conversation.id], classification: 'operator-shared', producer })
  assert.equal(task.classification, 'local-private')
  assert.ok(taskSchema.safeParse({ instructions: 'x' }).success, 'context is optional: older tasks stay valid')
  assert.equal(taskSchema.safeParse({ instructions: 'x', context: ['not-an-id'] }).success, false)
})
