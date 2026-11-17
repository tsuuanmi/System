/** ms-1: `system defect add` and MCP `defect.add` store an `escaped-defect@1` Artifact through a real Host, and `work report` reads it. */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-defect', { SYSTEM_OPERATOR_ID: 'tester' })
const home = cli.home
const client = new Client({ name: 'defect', version: '0' })

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

test('system defect add prints an ID that artifact show reads as escaped-defect@1; bad subjects are refused', () => {
  const ran = cli.run(['defect', 'add', 'ms-1', '--found-by', 'work:abc', '--reason', 'broke the bootstrap', '--date', '2026-11-17'])
  assert.equal(ran.status, 0, ran.stderr)
  const envelope = shown(ran.stdout.trim())
  assert.equal(envelope.kind, 'escaped-defect')
  assert.equal(envelope.schemaVersion, 1)
  assert.deepEqual(envelope.content, { item: 'ms-1', foundBy: 'work:abc', reason: 'broke the bootstrap', date: '2026-11-17' })
  const commit = cli.run(['defect', 'add', '3ce107c', '--found-by', 'operator', '--reason', 'r'])
  assert.equal(commit.status, 0, commit.stderr)
  assert.equal(shown(commit.stdout.trim()).content.commit, '3ce107c')
  assert.notEqual(cli.run(['defect', 'add', 'NotAnItem', '--found-by', 'x', '--reason', 'r']).status, 0)
  assert.notEqual(cli.run(['defect', 'add', 'ms-1', '--found-by', 'x']).status, 0, 'a reason is required')
})

test('MCP defect.add returns an ID that artifact show reads as escaped-defect@1, and work report labels its source', async () => {
  const result = await client.callTool({ name: 'defect.add', arguments: { subject: 'ms-2', foundBy: 'text', reason: 'via MCP' } })
  const text = (result.content as { text: string }[])[0]!.text
  assert.notEqual(result.isError, true, text)
  const envelope = shown(JSON.parse(text).defect)
  assert.equal(envelope.kind, 'escaped-defect')
  assert.equal(envelope.content.item, 'ms-2')
  const report = cli.run(['work', 'report', '--since', '2000-01-01'])
  assert.equal(report.status, 0, report.stderr)
  const parsed = JSON.parse(report.stdout)
  assert.equal(parsed.escapedDefectRate.source, 'records')
  assert.equal(parsed.escapedDefectRate.escaped, 0, 'no Item was merged, so no recorded defect counts')
  assert.deepEqual(parsed.headline, { itemsMerged: 0, parts: { intentsSettled: 0, confirmations: 0, releases: 0, humanTouches: 0 }, operatorActs: 0, itemsPerAct: 'no acts' })
  const override = JSON.parse(cli.run(['work', 'report', '--since', '2000-01-01', '--escaped', '2']).stdout)
  assert.equal(override.escapedDefectRate.source, 'override (--escaped)')
})
