/**
 * `system mcp`: the SDK's MCP client spawns
 * `bin/system mcp` against a Host served in this process, over a fixture with
 * fake Workers.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ResourceUpdatedNotificationSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
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
async function mcp(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env: { ...process.env, DSH_HOME: home, SYSTEM_OPERATOR_ID: 'o1', ...env } as Record<string, string> })
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

const workflow = `schema: system.workflow/v1
id: mcp-file
version: 1
steps:
  - id: write
    capabilities: [code-write]
    outputs: [result]
`

test('work.submit with a path admits the Work as the agent', { timeout: 60_000 }, async () => {
  const path = join(mkdtempSync(join(home, 'wf-')), 'wf.yaml')
  writeFileSync(path, workflow)
  const submitted = await call(await mcp(), 'work.submit', { workflow: path, run: false })
  assert.equal(submitted.error, undefined, submitted.error)
  assert.ok(submitted.value.id)
  assert.deepEqual(submitted.value.events[0].caller, { type: 'agent', operatorId: 'o1' })
})

test('work.submit with a ~ path expands the MCP process HOME', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(home, 'wf-home-'))
  writeFileSync(join(dir, 'wf.yaml'), workflow)
  const submitted = await call(await mcp({ HOME: dir }), 'work.submit', { workflow: '~/wf.yaml', run: false })
  assert.equal(submitted.error, undefined, submitted.error)
  assert.ok(submitted.value.id)
})

test('work.submit with a path reads a Sub-workflow beside the file', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(home, 'wf-sub-'))
  writeFileSync(join(dir, 'main.yaml'), 'schema: system.workflow/v1\nid: main\nversion: 1\nsteps:\n  - id: c\n    uses: sub.yaml\n')
  writeFileSync(join(dir, 'sub.yaml'), workflow)
  const client = await mcp()
  const submitted = await call(client, 'work.submit', { workflow: join(dir, 'main.yaml'), run: false })
  assert.equal(submitted.error, undefined, submitted.error)
  assert.ok(submitted.value.id)
  const shown = await call(client, 'work.show', { workId: submitted.value.id })
  assert.equal(shown.error, undefined, shown.error)
  assert.deepEqual(Object.keys(shown.value.state.steps), ['c.write'])
})

test('work.submit with contents still admits the Work', { timeout: 60_000 }, async () => {
  const submitted = await call(await mcp(), 'work.submit', { workflow, run: false })
  assert.equal(submitted.error, undefined, submitted.error)
  assert.ok(submitted.value.id)
})

test('work.submit with a missing path reports an unreadable file', { timeout: 60_000 }, async () => {
  const path = join(mkdtempSync(join(home, 'wf-missing-')), 'missing.yaml')
  const submitted = await call(await mcp(), 'work.submit', { workflow: path, run: false })
  assert.equal(typeof submitted.error, 'string')
  assert.match(submitted.error!, /not a readable file/)
  assert.doesNotMatch(submitted.error!, /expected object/)
})

test('work.submit with neither a file nor Workflow contents explains both accepted forms', { timeout: 60_000 }, async () => {
  const submitted = await call(await mcp(), 'work.submit', { workflow: 'hello', run: false })
  assert.equal(typeof submitted.error, 'string')
  assert.match(submitted.error!, /neither the path of a readable \.yaml file nor the contents of a Workflow/)
})

test('the instructions and the work.submit description agree on paths and contents', { timeout: 60_000 }, async () => {
  const client = await mcp()
  const instructions = client.getInstructions() ?? ''
  assert.ok(instructions.includes('workflows/feature.yaml'))
  const { tools } = await client.listTools()
  const submit = tools.find((tool) => tool.name === 'work.submit')
  assert.ok(submit)
  assert.match(submit.description ?? '', /path/)
  assert.match(submit.description ?? '', /contents/)
  assert.match(instructions, /contents/)
})

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
  assert.deepEqual(Object.keys(submit.inputSchema.properties ?? {}).sort(), ['capabilities', 'commandId', 'force', 'input', 'run', 'uses', 'worker', 'workflow'])
  const claim = tools.find((t) => t.name === 'item.claim')!
  assert.ok(Object.hasOwn(claim.inputSchema.properties ?? {}, 'commandId'))
  for (const closed of ['approval.decide', 'credentials.set', 'workers.login']) assert.ok(!tools.some((t) => t.name === closed), `${closed} is listed`)
})

test('item_claim accepts commandId through MCP and status reports the claim', { timeout: 60_000 }, async () => {
  const project = realpathSync(mkdtempSync(join(home, 'mcp-claim-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'dev')
  writeFileSync(join(project, 'STATUS.md'), 'Aim: a project\n- [ ] p-2 Second\n')
  git('add', '.'); git('commit', '-qm', 'status')
  const client = await mcp()
  const claimed = await call(client, 'item.claim', { repository: project, item: 'p-2', commandId: 'c-mcp' })
  assert.equal(claimed.error, undefined, claimed.error)
  assert.equal(claimed.value.who, 'o1')
  assert.match(((await call(client, 'status', { repository: project, item: 'p-2' })).value as string[])[0]!, /doing: claimed by o1 since/)
})

test('work.submit runs the Work unless run is false; work.list shows an unrun Work as admitted, not running', { timeout: 60_000 }, async () => {
  const client = await mcp()
  const held = (await call(client, 'work.submit', { capabilities: ['code-write'], run: false })).value.id as string
  const listed = async (id: string) => ((await call(client, 'work.list', {})).value as { id: string; status: string }[]).find((w) => w.id === id)?.status
  assert.equal(await listed(held), 'admitted, not running')
  const id = (await call(client, 'work.submit', { capabilities: ['code-write'] })).value.id as string
  await until('the Work to end', async () => (await call(client, 'work.events', { workId: id })).value.status === 'succeeded')
  assert.equal(await listed(id), 'succeeded')
  assert.equal(await listed(held), 'admitted, not running')
})

test('a tool call goes to the Host: submit a direct Task, run it and follow it with work.events', { timeout: 60_000 }, async () => {
  const client = await mcp()
  const submitted = await call(client, 'work.submit', { capabilities: ['code-write'], run: false })
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
  const id = (await call(client, 'work.submit', { capabilities: ['code-write'], run: false })).value.id as string
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
  const quiet = (await call(client, 'work.submit', { capabilities: ['code-write'], run: false })).value.id as string
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
  const id = (await call(first, 'work.submit', { capabilities: ['code-write'], run: false })).value.id as string
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

test('the initialize result carries instructions: the steps, the checks file and the human-only commands', { timeout: 60_000 }, async () => {
  const text = (await mcp()).getInstructions() ?? ''
  for (const word of ['status', 'item_claim', 'task_new', 'work_submit', '.system/checks.yaml', 'system approve', 'system deny', 'system work retry']) assert.ok(text.includes(word), `instructions lack ${word}`)
})

test('the instructions name feature.yaml as the Workflow for a code change and keep software-engineering.yaml for the small case', { timeout: 60_000 }, async () => {
  const text = (await mcp()).getInstructions() ?? ''
  assert.ok(text.includes('workflows/feature.yaml'))
  assert.ok(text.indexOf('feature.yaml') < text.indexOf('software-engineering.yaml'))
  assert.ok(text.includes('software-engineering.yaml'))
  assert.ok(text.includes('red:'))
})

test('an MCP server of older code than the Host recovers on the code under SYSTEM_CODE, and its session keeps working', { timeout: 60_000 }, async () => {
  // A Host of other code than this build's, and an install whose `current` code is that Host's.
  const dir = mkdtempSync('/tmp/sm-old-')
  const lib = join(dir, 'packages', 'host', 'lib')
  mkdirSync(lib, { recursive: true })
  const real = new URL('../../host/lib/index.js', import.meta.url).href
  writeFileSync(join(lib, 'index.js'), `export * from '${real}'\nexport const VERSION = 'newer-code'\n`)
  mkdirSync(join(dir, 'system'))
  const f = fixture()
  mkdirSync(join(dir, 'data'))
  const host = await f.startHost(join(dir, 'data'))
  const server = await serve(host, { path: join(dir, 'system', 'host.sock'), methods: operations({ capabilities: f.capabilities, artifact: (id: string) => artifacts.get(id) } as Services), version: 'newer-code', onDisk: () => 'newer-code' })
  // The client's own refusal names the client, not the Host.
  const old = await connect(join(dir, 'system', 'host.sock'))
  await assert.rejects(old.call('host.hello', { version: VERSION, caller: human }), /the client is older: restart the client/)
  old.close()
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env: { ...process.env, DSH_HOME: dir, SYSTEM_CODE: dir, SYSTEM_OPERATOR_ID: 'o1' } as Record<string, string> })
  const client = new Client({ name: 'test', version: '0' })
  clients.push(client)
  await client.connect(transport)
  const listed = await call(client, 'work.list')
  assert.equal(listed.error, undefined, listed.error)
  assert.deepEqual(listed.value, [])
  await client.close()
  await server.close()
  await host.close()
  rmSync(dir, { recursive: true, force: true })
})

test('an MCP session refreshes its tools and notifies after recovering on newer Host code', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync('/tmp/sm-refresh-')
  const lib = join(dir, 'packages', 'host', 'lib')
  mkdirSync(lib, { recursive: true })
  const realIndex = new URL('../../host/lib/index.js', import.meta.url).href
  const realOperations = new URL('../../host/lib/operations.js', import.meta.url).href
  const extra = "'test.ping': { agent: true, summary: 'ping', params: undefined, handler: () => 'pong' }"
  writeFileSync(join(lib, 'index.js'), `export * from '${realIndex}'\nexport const VERSION = 'newer-code'\n`)
  writeFileSync(join(lib, 'operations.js'), `import { operations as real } from '${realOperations}'\nexport const operations = (s) => ({ ...real(s), ${extra} })\n`)
  mkdirSync(join(dir, 'system'))
  const f = fixture()
  mkdirSync(join(dir, 'data'))
  const host = await f.startHost(join(dir, 'data'))
  const methods = operations({ capabilities: f.capabilities, artifact: (id: string) => artifacts.get(id) } as Services)
  const server = await serve(host, {
    path: join(dir, 'system', 'host.sock'),
    methods: { ...methods, 'test.ping': { agent: true, summary: 'ping', params: undefined, handler: () => 'pong' } },
    version: 'newer-code',
    onDisk: () => 'newer-code',
  })
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env: { ...process.env, DSH_HOME: dir, SYSTEM_CODE: dir, SYSTEM_OPERATOR_ID: 'o1' } as Record<string, string> })
  const client = new Client({ name: 'test', version: '0' })
  clients.push(client)
  const changed: unknown[] = []
  client.setNotificationHandler(ToolListChangedNotificationSchema, (notice) => { changed.push(notice) })
  try {
    await client.connect(transport)
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, true)
    const initial = await client.listTools()
    assert.ok(!initial.tools.some((tool) => tool.name === 'test.ping'))
    const listed = await call(client, 'work.list')
    assert.equal(listed.error, undefined, listed.error)
    await until('tools/list_changed', async () => changed.length > 0)
    const refreshed = await client.listTools()
    assert.ok(refreshed.tools.some((tool) => tool.name === 'test.ping'))
    assert.deepEqual(await call(client, 'test.ping'), { value: 'pong' })
    assert.match((await call(client, 'not.a.tool')).error!, /unknown tool/)
  } finally {
    await client.close()
    await server.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
