/**
 * `system mcp` (ADR-0009 decisions 3 and 4): the SDK's MCP client spawns
 * `bin/system mcp` against a Host served in this process, over a fixture with
 * fake Workers. The scope itself is the Host's, tested in @system/host; here
 * it is seen through the adapter.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { GOAL_KIND, TASK_KIND, goalSchema, taskSchema } from '@system/work'
import { fixture } from '../../../test-support/fixture.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { NOT_ALLOWED, VERSION, connect, serve, tableOf } from '../../host/src/index.ts'
import { operations, type Services } from '../../host/src/operations.ts'

const entry = new URL('../../../bin/system', import.meta.url).pathname
// A socket path is limited to about 100 bytes, and tmpdir() may be longer.
const home = mkdtempSync('/tmp/sm-')
const human = { type: 'human', operatorId: 'tan' }
const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...GOAL_KIND, content: goalSchema })
const services = {
  capabilities: undefined as unknown as Services['capabilities'],
  artifact: (id: string) => artifacts.get(id),
  async newGoal(goal, supersedes, caller) {
    const producer = { type: 'operator', ref: caller.operatorId } as const
    const charter = await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: new TextEncoder().encode('charter'), mediaType: 'text/markdown', classification: 'public', producer })
    const stored = await artifacts.put({ ...GOAL_KIND, content: { context: [charter.id], ...goal }, inputs: [charter.id], supersedes: supersedes ? [supersedes] : [], classification: 'public', producer })
    return { id: stored.id }
  },
} as Services
const table = tableOf(operations(services))
let stop: () => Promise<void>
let human1: Awaited<ReturnType<typeof connect>>
const clients: Client[] = []

before(async () => {
  const f = fixture({ goals: artifacts })
  mkdirSync(join(home, 'data'))
  const host = await f.startHost(join(home, 'data'))
  services.capabilities = f.capabilities
  mkdirSync(join(home, 'system'))
  const server = await serve(host, { path: join(home, 'system', 'host.sock'), methods: operations(services) })
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
  assert.deepEqual(Object.keys(submit.inputSchema.properties ?? {}).sort(), ['capabilities', 'commandId', 'goal', 'input', 'workflow'])
  for (const closed of ['approval.decide', 'credentials.set', 'conversation.add', 'goal.new']) assert.ok(!tools.some((t) => t.name === closed), `${closed} is listed`)
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

test('with --goal the Host scopes the tools to the Goal of the orchestrator', { timeout: 60_000 }, async () => {
  const goal = async (aim: string) => (await human1.call('goal.new', { aim, scope: 's', budget: {} }) as { id: string }).id
  const [a, b] = [await goal('a'), await goal('b')]
  const direct = async (goalId?: string) => (await human1.call('work.submit', { capabilities: ['code-write'], goal: goalId }) as { id: string }).id
  const [other, free] = [await direct(b), await direct()]
  const client = await mcp('--goal', a)

  const own = await call(client, 'work.submit', { capabilities: ['code-write'] })
  assert.equal(own.value.events[0].goal, a)
  assert.deepEqual(own.value.events[0].caller, { type: 'orchestrator', operatorId: 'o1', goal: a })
  assert.match((await call(client, 'work.submit', { capabilities: ['code-write'], goal: b })).error!, /scope/)
  assert.deepEqual((await call(client, 'work.list')).value.map((r: { id: string }) => r.id), [own.value.id])
  for (const id of [other, free]) {
    for (const tool of ['work.run', 'work.cancel', 'work.show']) assert.match((await call(client, tool, { workId: id })).error!, /scope/, `${tool} ${id}`)
  }
  const spec = (await human1.call('work.show', { workId: other }) as { events: { specId: string }[] }).events[0]!.specId
  assert.match((await call(client, 'artifact.show', { id: spec })).error!, /scope/)
  assert.match((await call(client, 'artifact.cat', { id: spec })).error!, /scope/)
  assert.equal((await call(client, 'work.run', { workId: own.value.id })).value.id, own.value.id)
})

test('over the socket an orchestrator connection is refused what is flagged agent: false', { timeout: 60_000 }, async () => {
  const socket = await connect(join(home, 'system', 'host.sock'))
  after(() => socket.close())
  await socket.call('host.hello', { version: VERSION, caller: { type: 'orchestrator', operatorId: 'o1', goal: `sha256:${'a'.repeat(64)}` } })
  for (const method of ['approval.decide', 'credentials.set', 'conversation.add', 'goal.new']) {
    await assert.rejects(socket.call(method, {}), (error: { code: number }) => error.code === NOT_ALLOWED, method)
  }
})

const textOf = (read: { contents: object[] }) => JSON.parse((read.contents[0] as { text: string }).text)

test('a subscribed resource is updated when its Work ends; reading it gives work.show', { timeout: 60_000 }, async () => {
  const goalId = (await human1.call('goal.new', { aim: 'watch', scope: 's', budget: {} }) as { id: string }).id
  const client = await mcp('--goal', goalId)
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
  await assert.rejects(client.readResource({ uri: 'system://work/work:nope' }), /scope/)
  await assert.rejects(client.readResource({ uri: 'file:///etc/passwd' }))
})

test('with --goal a new Work of the Goal changes the resource list, and a Work outside it does not appear', { timeout: 60_000 }, async () => {
  const goalId = (await human1.call('goal.new', { aim: 'list', scope: 's', budget: {} }) as { id: string }).id
  const client = await mcp('--goal', goalId)
  let changed = 0
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { changed++ })
  await client.listResources()
  const outside = await human1.call('work.submit', { capabilities: ['code-write'] }) as { id: string }
  const own = await human1.call('work.submit', { capabilities: ['code-write'], goal: goalId }) as { id: string }
  await until('list_changed', async () => changed > 0)
  assert.equal(changed, 1)
  const uris = (await client.listResources()).resources.map((r) => r.uri)
  assert.deepEqual(uris, [`system://work/${own.id}`])
  assert.ok(!uris.includes(`system://work/${outside.id}`))
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
