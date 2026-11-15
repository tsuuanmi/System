/** `tools/mcp-probe.mjs` (Item fl-6): the `mcp` afterInstall check, against fake servers and the real `bin/system mcp`. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { repo, systemCli } from '../test-support/cli.ts'

const dir = mkdtempSync('/tmp/mcp-probe-')
after(() => rmSync(dir, { recursive: true, force: true }))
const probe = join(repo, 'tools', 'mcp-probe.mjs')
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [probe, ...args], { encoding: 'utf8', timeout: 60_000, env })

/** A fake MCP server: answers initialize, and tools/list with `tools`; `hang` never answers tools/list. */
const fake = (name: string, tools: unknown[], hang = false): string[] => {
  const file = join(dir, `${name}.mjs`)
  writeFileSync(file, `
import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line)
  if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } }))
  else if (m.method === 'tools/list' && ${hang}) await new Promise(() => {})
  else if (m.method === 'tools/list') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: ${JSON.stringify(tools)} } }))
}
`)
  return [process.execPath, file]
}

test('a server that lists a tool passes and the tool count is printed', () => {
  const r = run(['--', ...fake('one', [{ name: 'work.list', inputSchema: { type: 'object' } }])])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /1 tool/)
})

test('a server that lists no tool fails', () => {
  const r = run(['--', ...fake('none', [])])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /no tool/)
})

test('a server that never answers fails at the timeout', () => {
  const r = run(['--timeout', '2', '--', ...fake('hang', [], true)])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /timed out after 2 s/)
})

test('a command that is not there fails', () => {
  const r = run(['--', '/nonexistent/mcp-server'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /could not start|exited/)
})

test('the real bin/system mcp answers initialize and tools/list', () => {
  const cli = systemCli('mcp-probe')
  const r = run(['--', process.execPath, join(repo, 'bin', 'system'), 'mcp'], cli.env)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\d+ tools?/)
})
