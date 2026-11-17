/** in-1: `system intent new` and MCP `intent_new` store an `intent@1` Artifact through a real Host. */
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-intent', { SYSTEM_OPERATOR_ID: 'tester' })
const home = cli.home
const client = new Client({ name: 'intent', version: '0' })
const BODY = '## Outcome\nA\n\n## Why\nB\n\n## Constraints\nC\n\n## Out of scope\nD\n'

before(async () => {
  assert.equal(cli.run(['init']).status, 0)
  await cli.start()
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'bin', 'system'), 'mcp'], env: cli.env as Record<string, string> }))
})

after(async () => {
  await client.close()
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

const shown = (id: string) => {
  const ran = cli.run(['artifact', 'show', id])
  assert.equal(ran.status, 0, ran.stderr)
  return JSON.parse(ran.stdout)
}

test('system intent new (--body-file and --body) prints an ID that artifact show reads as intent@1', () => {
  const file = join(home, 'intent.md')
  writeFileSync(file, BODY)
  const ran = cli.run(['intent', 'new', '--title', 'First', '--body-file', file])
  assert.equal(ran.status, 0, ran.stderr)
  const id = ran.stdout.trim()
  const envelope = shown(id).envelope ?? shown(id)
  assert.equal(envelope.kind, 'intent')
  assert.equal(envelope.schemaVersion, 1)
  assert.deepEqual(envelope.content, { title: 'First', body: BODY })

  const second = cli.run(['intent', 'new', '--title', 'Second', '--body', 'Short.', '--supersedes', id])
  assert.equal(second.status, 0, second.stderr)
  assert.equal((shown(second.stdout.trim()).envelope ?? shown(second.stdout.trim())).content.supersedes, id)

  const bad = cli.run(['intent', 'new', '--title', 'Bad', '--body', 'x', '--supersedes', `sha256:${'0'.repeat(64)}`])
  assert.notEqual(bad.status, 0)
  assert.equal(cli.run(['intent', 'new', '--title', 'Bad']).status === 0, false, 'a body is required')
})

test('MCP intent_new (the tool intent.new) returns an ID that artifact show reads as intent@1', async () => {
  const result = await client.callTool({ name: 'intent.new', arguments: { title: 'Via MCP', body: BODY } })
  const text = (result.content as { text: string }[])[0]!.text
  assert.notEqual(result.isError, true, text)
  const { intent } = JSON.parse(text)
  const envelope = shown(intent).envelope ?? shown(intent)
  assert.equal(envelope.kind, 'intent')
  assert.deepEqual(envelope.content, { title: 'Via MCP', body: BODY })
})
