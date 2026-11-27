/**
 * Smoke test for Authority (Item authority-1, ADR-0011): through a real booted
 * Host, every `operator` operation is absent from `system mcp`'s tool list,
 * calling one over MCP is refused, and calling one from a non-terminal CLI is
 * refused while a terminal caller reaches the Host.
 */
import assert from 'node:assert/strict'
import { rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { NOT_ALLOWED, VERSION, connect, tableOf } from '../packages/host/src/index.ts'
import { operatorSocketPath, socketPath } from '../packages/host/src/process.ts'
import { operations, type Services } from '../packages/host/src/operations.ts'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('authority', {})
const table = tableOf(operations({} as Services))

before(async () => {
  const ran = cli.run(['init'])
  assert.equal(ran.status, 0, ran.stderr)
  await cli.start()
})

after(async () => {
  await cli.stop()
  rmSync(cli.home, { recursive: true, force: true })
})

test('through a real Host, operator operations are absent from system mcp and refused over MCP', { timeout: 120_000 }, async () => {
  const operators = Object.entries(table).filter(([, m]) => m.authority === 'operator').map(([name]) => name)
  const callers = Object.entries(table).filter(([, m]) => m.authority === 'caller').map(([name]) => name)
  assert.ok(operators.includes('approval.decide'), 'approval.decide has operator authority')

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repo, 'bin', 'system'), 'mcp'],
    env: cli.env as Record<string, string>,
  })
  const client = new Client({ name: 'authority-smoke', version: '0' })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), callers.sort())
    for (const op of operators) {
      assert.ok(!tools.some((t) => t.name === op), `${op} must not appear in MCP tools`)
      const result = await client.callTool({ name: op, arguments: {} }) as { isError?: boolean; content: { text: string }[] }
      assert.equal(result.isError, true, `calling ${op} over MCP must fail`)
      assert.match(result.content[0]!.text, /unknown tool/)
    }
    const list = await client.callTool({ name: 'work.list', arguments: {} }) as { isError?: boolean; content: { text: string }[] }
    assert.notEqual(list.isError, true, list.content[0]?.text)
    assert.deepEqual(JSON.parse(list.content[0]!.text), [])
  } finally {
    await client.close()
  }
})

test('through a real Host, an operator operation refuses a non-terminal CLI caller (ADR-0011) and accepts a terminal caller', { timeout: 120_000 }, async () => {
  const piped = cli.run(['credentials', 'status', 'NO_SUCH_KEY'])
  assert.equal(piped.status, 1)
  assert.match(piped.stderr, /operator authority|not allowed for agents/)

  // Even a direct socket client declaring an agent caller is refused `approval.decide` by the real Host.
  const client = await connect(socketPath(cli.home))
  try {
    await client.call('host.hello', { version: VERSION, caller: { type: 'agent', operatorId: 'a1' } })
    await assert.rejects(
      client.call('approval.decide', { workId: 'work:none', decision: 'approved', reason: 'ok' }),
      (error: { code: number; message: string }) => error.code === NOT_ALLOWED && /operator authority|not allowed for agents/.test(error.message),
    )
  } finally {
    client.close()
  }

  const tty = cli.run(['credentials', 'status', 'NO_SUCH_KEY'], { terminal: true })
  assert.equal(tty.status, 1, 'key is not configured, but the Host answered')
  assert.match(tty.stdout, /NO_SUCH_KEY {2}not configured/)
  assert.doesNotMatch(tty.stderr, /operator authority|not allowed for agents/)
})

test('through a real Host, host.sock refuses every operator operation to a client that says it is a human; the operator socket directory is 0700', { timeout: 120_000 }, async () => {
  assert.equal(statSync(dirname(operatorSocketPath(cli.home))).mode & 0o777, 0o700)
  const operators = Object.entries(table).filter(([, m]) => m.authority === 'operator').map(([name]) => name)
  const client = await connect(socketPath(cli.home))
  try {
    await client.call('host.hello', { version: VERSION, caller: { type: 'human', operatorId: 'a1' } })
    for (const name of operators) {
      await assert.rejects(client.call(name, {}), (error: { code: number }) => error.code === NOT_ALLOWED, name)
    }
  } finally {
    client.close()
  }
})
