import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fakeCodexHome } from '../../../test-support/accounts.ts'
import { systemCli } from '../../../test-support/cli.ts'
import { codexRateLimits, fakeQuotaCli, object } from '../../../test-support/quota.ts'

test('workers.list through MCP returns each account quota without a token or a model turn', async (t) => {
  const cli = systemCli('sm-quota')
  const { home } = cli
  t.after(async () => { await cli.stop(); rmSync(home, { recursive: true, force: true }) })
  const initialized = cli.run(['init'])
  assert.equal(initialized.status, 0, initialized.stderr)
  const codexHome = fakeCodexHome(join(home, 'quota-home'), 'quota-provider')
  const fake = fakeQuotaCli(join(home, 'quota-cli'), { kind: 'codex', version: '0.166.0', answer: codexRateLimits({ primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: null } }) })
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents
  config:
    $patch: replace
    accounts:
      - {ref: codex/quota, runtime: codex, capabilities: [research], command: ${JSON.stringify(fake.command)}, codexHome: ${JSON.stringify(codexHome)}}
      - {ref: web/chatgpt/quota, runtime: web, site: chatgpt, capabilities: [research]}
`)
  await cli.start()

  const client = new Client({ name: 'quota-smoke', version: '0' })
  t.after(() => client.close())
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../../../bin/system', import.meta.url).pathname, 'mcp'], env: { ...cli.env } as Record<string, string> }))
  const read = async () => {
    const result = await client.callTool({ name: 'workers.list', arguments: {} })
    assert.ok(!result.isError, JSON.stringify(result))
    const content = result.content as { type: string; text: string }[]
    return object(JSON.parse(content[0]!.text))
  }
  const first = await read()
  assert.doesNotMatch(JSON.stringify(first), /fake-token|SECRET-ACCESS|SECRET-REFRESH/)
  const accounts = first.accounts as { ref: string; quota?: unknown }[]
  assert.equal(accounts.length, 2)
  for (const account of accounts) assert.ok(account.quota, `${account.ref} has quota`)
  const quota = object(accounts.find((account) => account.ref === 'codex/quota')!.quota)
  assert.ok(Number.isFinite(Date.parse(String(quota.observedAt))))
  assert.deepEqual(quota.windows, { five_hour: { percentUsed: 17 } })
  assert.deepEqual(accounts.find((account) => account.ref === 'web/chatgpt/quota')!.quota, { unreadable: 'a web account has no quota reader' })
  const log = fake.readLog()
  assert.deepEqual(log.filter((entry) => entry.stdin !== undefined).map((entry) => object(entry.stdin).method), ['initialize', 'initialized', 'account/rateLimits/read'])
  assert.deepEqual(await read(), first, 'workers.list reuses the ten-minute quota cache')
  assert.deepEqual(fake.readLog(), log, 'a cached listing never starts another read')
})
