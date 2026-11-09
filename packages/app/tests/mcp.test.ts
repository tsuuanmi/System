/**
 * `system mcp`: the SDK's MCP client spawns
 * `bin/system mcp` against a Host served in this process, over a fixture with
 * fake Workers.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { TASK_KIND, taskSchema } from '@system/work'
import { fixture } from '../../../test-support/fixture.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { VERSION, connect, serve, tableOf } from '../../host/src/index.ts'
import { operations, type Services } from '../../host/src/operations.ts'

const entry = new URL('../../../bin/system', import.meta.url).pathname
// A socket path is limited to about 100 bytes, and tmpdir() may be longer.
const home = mkdtempSync('/tmp/sm-')
const human = { type: 'human', operatorId: 'tan' }
const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema })
const services = {
  capabilities: undefined as unknown as Services['capabilities'],
  artifact: (id: string) => artifacts.get(id),
} as Services
const table = tableOf(operations(services))
let stop: () => Promise<void>
let human1: Awaited<ReturnType<typeof connect>>
const clients: Client[] = []

before(async () => {
  const f = fixture()
  mkdirSync(join(home, 'data'))
  const host = await f.startHost(join(home, 'data'))
  services.capabilities = f.capabilities
  mkdirSync(join(home, 'system'))
  const listen = () => serve(host, { path: join(home, 'system', 'host.sock'), methods: operations(services) })
  const server = await listen()
  stop = async () => { await server.close(); await host.close() }
  human1 = await connect(join(home, 'system', 'host.sock'))
  await human1.call('host.hello', { version: VERSION, caller: human })
})

after(async () => {
  human1.close()
  await Promise.all(clients.map((client) => client.close()))
  await stop()
  rmSync(home, { recursive: true, force: true })
})

/** An MCP client on a `bin/system mcp` child of this Host. */
async function mcp(...args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp', ...args], env: { ...process.env, DSH_HOME: home, SYSTEM_OPERATOR_ID: 'o1' } as Record<string, string> })
  const client = new Client({ name: 'test', version: '0' })
  clients.push(client)
  await client.connect(transport)
  return client
}

/** The text of a tool result, parsed; `error` when the tool reported one. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ error?: string; value?: any }> {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] }
  const text = result.content[0]!.text
  return result.isError ? { error: text } : { value: JSON.parse(text) }
}

const until = async (what: string, ok: () => Promise<boolean>) => {
  for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (await ok()) return
  assert.fail(`timed out waiting for ${what}`)
}

test('the tools are exactly the rows flagged agent: true, with their schemas and descriptions', { timeout: 60_000 }, async () => {
  const client = await mcp()
  const { tools } = await client.listTools()
  const open = Object.entries(table).filter(([, method]) => method.agent)
  assert.deepEqual(tools.map((t) => t.name).sort(), open.map(([name]) => name).sort())
  for (const tool of tools) {
    assert.equal(tool.description, table[tool.name]!.summary)
    assert.equal(tool.inputSchema.type, 'object')
  }
  const submit = tools.find((t) => t.name === 'work.submit')!
  assert.deepEqual(Object.keys(submit.inputSchema.properties ?? {}).sort(), ['capabilities', 'commandId', 'input', 'uses', 'worker', 'workflow'])
  for (const closed of ['approval.decide', 'credentials.set', 'conversation.add', 'workers.login']) assert.ok(!tools.some((t) => t.name === closed), `${closed} is listed`)
})

test('a tool call goes to the Host: submit a direct Task, run it and follow it with work.events', { timeout: 60_000 }, async () => {
  const client = await mcp()
  const submitted = await call(client, 'work.submit', { capabilities: ['code-write'] })
  const id = submitted.value.id as string
  assert.deepEqual(submitted.value.events[0].caller, { type: 'agent', operatorId: 'o1' })
  assert.equal((await call(client, 'work.run', { workId: id })).value.id, id)
  await until('the Work to end', async () => (await call(client, 'work.events', { workId: id })).value.status !== 'running')
  assert.equal((await call(client, 'work.events', { workId: id })).value.status, 'succeeded')
  assert.match((await call(client, 'work.show', { workId: 'work:nope' })).error!, /no Work work:nope/)
  assert.match((await call(client, 'work.show', {})).error!, /invalid params/)
})

test('--goal is no longer an option: the adapter refuses it and starts nothing', () => {
  const run = spawnSync(process.execPath, [entry, 'mcp', '--goal', `sha256:${'a'.repeat(64)}`], { env: { ...process.env, DSH_HOME: home, SYSTEM_OPERATOR_ID: 'o1' }, encoding: 'utf8', timeout: 30_000 })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /usage: system mcp\n/)
})

const textOf = (read: { contents: object[] }) => JSON.parse((read.contents[0] as { text: string }).text)

test('a subscribed resource is updated when its Work ends; reading it gives work.show', { timeout: 60_000 }, async () => {
  const client = await mcp()
  const updated: string[] = []
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { updated.push(n.params.uri) })
  const id = (await call(client, 'work.submit', { capabilities: ['code-write'] })).value.id as string
  const uri = `system://work/${id}`
  assert.ok((await client.listResources()).resources.some((r) => r.uri === uri))
  await client.subscribeResource({ uri })
  await call(client, 'work.run', { workId: id })
  await until('the update', async () => updated.length > 0)
  assert.deepEqual(updated, [uri])
  const shown = textOf(await client.readResource({ uri }))
  assert.equal(shown.id, id)
  assert.equal(shown.state.status, 'succeeded')
  // After an unsubscribe a later change says nothing.
  const quiet = (await call(client, 'work.submit', { capabilities: ['code-write'] })).value.id as string
  await client.subscribeResource({ uri: `system://work/${quiet}` })
  await client.unsubscribeResource({ uri: `system://work/${quiet}` })
  await call(client, 'work.run', { workId: quiet })
  await until('the Work to end', async () => (await call(client, 'work.events', { workId: quiet })).value.status === 'succeeded')
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(updated, [uri])
  await assert.rejects(client.readResource({ uri: 'system://work/work:nope' }), /no Work work:nope/)
  await assert.rejects(client.readResource({ uri: 'file:///etc/passwd' }))
})

test('a notice only wakes the client: one that was away reads work.events from its cursor and misses nothing', { timeout: 60_000 }, async () => {
  const first = await mcp()
  const id = (await call(first, 'work.submit', { capabilities: ['code-write'] })).value.id as string
  await first.subscribeResource({ uri: `system://work/${id}` })
  const cursor = (await call(first, 'work.events', { workId: id })).value.events.at(-1).seq as number
  await first.close()
  // The Work ends while no client is connected: nobody hears a notice.
  await human1.call('work.run', { workId: id })
  await until('the Work to end', async () => ((await human1.call('work.events', { workId: id })) as { status: string }).status === 'succeeded')
  const second = await mcp()
  const missed = (await call(second, 'work.events', { workId: id, after: cursor })).value
  const all = (await call(second, 'work.events', { workId: id })).value
  assert.equal(missed.status, 'succeeded')
  assert.deepEqual(missed.events, all.events.slice(cursor + 1))
  assert.equal(missed.events.at(-1).type, 'terminal')
})
