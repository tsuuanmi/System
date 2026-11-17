/** ms-2: `system confirm` and MCP `artifact.confirm` store a `confirmation@1`; `intent new --settled-by-operator` marks an Intent; `work report` counts both as operator acts, through a real Host. */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-confirm', { SYSTEM_OPERATOR_ID: 'tester' })
const home = cli.home
const client = new Client({ name: 'confirm', version: '0' })

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
  const out = JSON.parse(ran.stdout)
  return out.envelope ?? out
}
const headline = () => {
  const ran = cli.run(['work', 'report', '--since', '2000-01-01'])
  assert.equal(ran.status, 0, ran.stderr)
  return JSON.parse(ran.stdout).headline
}

test('system confirm stores a confirmation@1 and the report counts it, with a settled Intent and not an unsettled one', async () => {
  assert.deepEqual(headline().parts, { intentsSettled: 0, confirmations: 0, releases: 0, humanTouches: 0 })
  const settled = cli.run(['intent', 'new', '--title', 'Settled', '--body', 'x', '--settled-by-operator'])
  assert.equal(settled.status, 0, settled.stderr)
  assert.equal(shown(settled.stdout.trim()).content.settledBy, 'operator')
  const plain = cli.run(['intent', 'new', '--title', 'Plain', '--body', 'x'])
  assert.equal(plain.status, 0, plain.stderr)
  assert.equal(shown(plain.stdout.trim()).content.settledBy, undefined)

  const ran = cli.run(['confirm', settled.stdout.trim(), '--note', 'labelled set checked', '--date', '2026-11-17'])
  assert.equal(ran.status, 0, ran.stderr)
  const envelope = shown(ran.stdout.trim())
  assert.equal(envelope.kind, 'confirmation')
  assert.deepEqual(envelope.content, { subject: settled.stdout.trim(), by: 'operator', date: '2026-11-17', note: 'labelled set checked' })
  assert.notEqual(cli.run(['confirm', `sha256:${'0'.repeat(64)}`, '--note', 'x']).status, 0, 'an unknown Artifact is refused')

  const mcp = await client.callTool({ name: 'artifact.confirm', arguments: { subject: plain.stdout.trim(), note: 'via MCP' } })
  const text = (mcp.content as { text: string }[])[0]!.text
  assert.notEqual(mcp.isError, true, text)
  assert.equal(shown(JSON.parse(text).confirmation).kind, 'confirmation')

  // The unsettled Intent is not counted; the CLI confirmation (2026-11-17) and the MCP one (now) are.
  assert.deepEqual(headline(), { itemsMerged: 0, parts: { intentsSettled: 1, confirmations: 2, releases: 0, humanTouches: 0 }, operatorActs: 3, itemsPerAct: 0 })
  const before = JSON.parse(cli.run(['work', 'report', '--since', '2000-01-01', '--until', '2001-01-01']).stdout).headline
  assert.equal(before.operatorActs, 0, 'acts outside the range are not counted')
})
