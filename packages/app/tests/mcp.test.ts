/**
 * `system mcp`: the SDK's MCP client spawns
 * `bin/system mcp` against a Host served in this process, over a fixture with
 * fake Workers.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  readBytes: (id: string) => artifacts.readBytes(id),
  putFile: (data: Uint8Array, mediaType: string, classification: string, who: { operatorId: string }) => artifacts.putBytes({ kind: 'file', schemaVersion: 1, data, mediaType, classification: classification as 'local-private', producer: { type: 'operator', ref: who.operatorId } }),
} as unknown as Services
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
  for (const end = Date.now() + 120_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (await ok()) return
  assert.fail(`timed out waiting for ${what}`)
}

const workflow = `schema: system.workflow/v1
id: mcp-file
version: 1
steps:
  - id: write
    capabilities: [repo.write]
    outputs: [result]
`

test('work.submit with a path admits the Work as the agent', { timeout: 120_000 }, async () => {
  const path = join(mkdtempSync(join(home, 'wf-')), 'wf.yaml')
  writeFileSync(path, workflow)
  const submitted = await call(await mcp(), 'work.submit', { workflow: path, run: false })
  assert.equal(submitted.error, undefined, submitted.error)
  assert.ok(submitted.value.id)
  assert.deepEqual(submitted.value.events[0].caller, { type: 'agent', operatorId: 'o1' })
})

test('work.submit with a ~ path expands the MCP process HOME', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(home, 'wf-home-'))
  writeFileSync(join(dir, 'wf.yaml'), workflow)
  const submitted = await call(await mcp({ HOME: dir }), 'work.submit', { workflow: '~/wf.yaml', run: false })
  assert.equal(submitted.error, undefined, submitted.error)
  assert.ok(submitted.value.id)
})

test('work.submit with a path reads a Sub-workflow beside the file', { timeout: 120_000 }, async () => {
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

test('work.submit with contents still admits the Work', { timeout: 120_000 }, async () => {
  const submitted = await call(await mcp(), 'work.submit', { workflow, run: false })
  assert.equal(submitted.error, undefined, submitted.error)
  assert.ok(submitted.value.id)
})

test('work.submit with a missing path reports an unreadable file', { timeout: 120_000 }, async () => {
  const path = join(mkdtempSync(join(home, 'wf-missing-')), 'missing.yaml')
  const submitted = await call(await mcp(), 'work.submit', { workflow: path, run: false })
  assert.equal(typeof submitted.error, 'string')
  assert.match(submitted.error!, /not a readable file/)
  assert.doesNotMatch(submitted.error!, /expected object/)
})

test('work.submit with neither a file nor Workflow contents explains both accepted forms', { timeout: 120_000 }, async () => {
  const submitted = await call(await mcp(), 'work.submit', { workflow: 'hello', run: false })
  assert.equal(typeof submitted.error, 'string')
  assert.match(submitted.error!, /neither the path of a readable \.yaml file nor the contents of a Workflow/)
})

test('the instructions and the work.submit description agree on paths and contents', { timeout: 120_000 }, async () => {
  const client = await mcp()
  const instructions = client.getInstructions() ?? ''
  assert.ok(instructions.includes('workflows/develop.yaml'))
  const { tools } = await client.listTools()
  const submit = tools.find((tool) => tool.name === 'work.submit')
  assert.ok(submit)
  assert.match(submit.description ?? '', /path/)
  assert.match(submit.description ?? '', /contents/)
  assert.match(instructions, /contents/)
})

test('the tools are exactly the rows with authority: caller; every operator operation is absent and refused over MCP', { timeout: 120_000 }, async () => {
  const client = await mcp()
  const { tools } = await client.listTools()
  const open = Object.entries(table).filter(([, method]) => method.authority === 'caller')
  const operators = Object.entries(table).filter(([, method]) => method.authority === 'operator')
  assert.ok(operators.length > 0, 'the table has operator operations')
  assert.deepEqual(tools.map((t) => t.name).sort(), open.map(([name]) => name).sort())
  for (const tool of tools) {
    assert.equal(tool.description, table[tool.name]!.summary)
    assert.equal(tool.inputSchema.type, 'object')
  }
  const submit = tools.find((t) => t.name === 'work.submit')!
  assert.deepEqual(Object.keys(submit.inputSchema.properties ?? {}).sort(), ['capabilities', 'commandId', 'force', 'input', 'run', 'uses', 'worker', 'workflow'])
  const claim = tools.find((t) => t.name === 'item.claim')!
  assert.ok(Object.hasOwn(claim.inputSchema.properties ?? {}, 'commandId'))
  for (const [closed] of operators) {
    assert.ok(!tools.some((t) => t.name === closed), `${closed} must not be listed as an MCP tool`)
    const refused = await call(client, closed, {})
    assert.equal(typeof refused.error, 'string', `${closed} must be refused over MCP`)
    assert.match(refused.error!, /unknown tool/)
  }
})

test('toolsOf derives from the operation table so a new operator or worker operation never appears as an MCP tool', async () => {
  const { toolsOf } = await import('../src/mcp.ts')
  const derived = toolsOf({
    tableOf,
    operations: (s) => ({
      ...operations(s),
      'test.operatorOnly': { authority: 'operator', summary: 'human only', handler: () => null },
      'test.workerOnly': { authority: 'worker', summary: 'worker only', handler: () => null },
      'test.callerOpen': { authority: 'caller', summary: 'caller ok', handler: () => null },
    }),
  })
  const names = derived.map((t) => t.name)
  assert.ok(names.includes('test.callerOpen'))
  assert.ok(!names.includes('test.operatorOnly'))
  assert.ok(!names.includes('test.workerOnly'))
})

test('item_claim accepts commandId through MCP and status reports the claim', { timeout: 120_000 }, async () => {
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

test('work.submit runs the Work unless run is false; work.list shows an unrun Work as admitted, not running', { timeout: 120_000 }, async () => {
  const client = await mcp()
  const held = (await call(client, 'work.submit', { capabilities: ['repo.write'], run: false })).value.id as string
  const listed = async (id: string) => ((await call(client, 'work.list', {})).value as { id: string; status: string }[]).find((w) => w.id === id)?.status
  assert.equal(await listed(held), 'admitted, not running')
  const id = (await call(client, 'work.submit', { capabilities: ['repo.write'] })).value.id as string
  await until('the Work to end', async () => (await call(client, 'work.events', { workId: id })).value.status === 'succeeded')
  assert.equal(await listed(id), 'succeeded')
  assert.equal(await listed(held), 'admitted, not running')
})

test('work_submit with a single Task by capability no.such.capability is refused through a real Host', { timeout: 120_000 }, async () => {
  const submitted = await call(await mcp(), 'work.submit', { capabilities: ['no.such.capability'], run: false })
  assert.equal(typeof submitted.error, 'string')
  assert.match(submitted.error!, /no\.such\.capability/)
})

test('a tool call goes to the Host: submit a direct Task, run it and follow it with work.events', { timeout: 120_000 }, async () => {
  const client = await mcp()
  const submitted = await call(client, 'work.submit', { capabilities: ['repo.write'], run: false })
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

test('a subscribed resource is updated when its Work ends; reading it gives work.show', { timeout: 120_000 }, async () => {
  const client = await mcp()
  const updated: string[] = []
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { updated.push(n.params.uri) })
  const id = (await call(client, 'work.submit', { capabilities: ['repo.write'], run: false })).value.id as string
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
  const quiet = (await call(client, 'work.submit', { capabilities: ['repo.write'], run: false })).value.id as string
  await client.subscribeResource({ uri: `system://work/${quiet}` })
  await client.unsubscribeResource({ uri: `system://work/${quiet}` })
  await call(client, 'work.run', { workId: quiet })
  await until('the Work to end', async () => (await call(client, 'work.events', { workId: quiet })).value.status === 'succeeded')
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(updated, [uri])
  await assert.rejects(client.readResource({ uri: 'system://work/work:nope' }), /no Work work:nope/)
  await assert.rejects(client.readResource({ uri: 'file:///etc/passwd' }))
})

test('a notice only wakes the client: one that was away reads work.events from its cursor and misses nothing', { timeout: 120_000 }, async () => {
  const first = await mcp()
  const id = (await call(first, 'work.submit', { capabilities: ['repo.write'], run: false })).value.id as string
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

test('the initialize result carries instructions: the steps, the checks file and the human-only commands', { timeout: 120_000 }, async () => {
  const text = (await mcp()).getInstructions() ?? ''
  for (const word of ['status', 'item_claim', 'task_new', 'intent_new', 'work_submit', '.system/checks.yaml', 'system approve', 'system deny', 'system work retry']) assert.ok(text.includes(word), `instructions lack ${word}`)
})

test('the instructions name develop.yaml as the Workflow for any change and only the canonical others', { timeout: 120_000 }, async () => {
  const text = (await mcp()).getInstructions() ?? ''
  assert.ok(text.includes('workflows/develop.yaml'))
  for (const name of ['hygiene', 'research', 'research-source', 'plan-items', 'brainstorm', 'code-checks']) assert.ok(text.includes(`${name}.yaml`), name)
  for (const gone of ['feature', 'software-engineering', 'debate', 'second-opinion', 'research-fanout', 'red:']) assert.ok(!text.includes(gone), gone)
})

test('the instructions tell the caller to write the Task under the six context-pack headings (fl-2)', async () => {
  const { INSTRUCTIONS } = await import('../src/mcp.ts')
  const text = INSTRUCTIONS.replace(/\s+/g, ' ')
  let at = text.indexOf('Goal')
  assert.ok(at >= 0, 'Goal')
  for (const heading of ['Files to change and why', 'Tests to add or update', 'Invariants not to change', 'Out of scope', 'Done when']) {
    const next = text.indexOf(heading, at)
    assert.ok(next > at, `${heading} after the previous heading`)
    at = next
  }
  assert.match(text, /workflows\/README\.md/)
})

test('the instructions say the Task of an Item is the Item\'s line, the pack is for a Task with no Item, and what (workflow: <name>) does (sch-7)', async () => {
  const { INSTRUCTIONS } = await import('../src/mcp.ts')
  const text = INSTRUCTIONS.replace(/\s+/g, ' ')
  assert.match(text, /Task of an Item is the Item's line/)
  assert.match(text, /names its files, its tests and what shows it is done/)
  assert.match(text, /For a Task that names no Item, write the instructions as a context pack/)
  assert.match(text, /\(workflow: <name>\)/)
  assert.match(text, /develop\.yaml unless/)
})

test('an MCP server of older code than the Host recovers on the code under SYSTEM_CODE, and its session keeps working', { timeout: 120_000 }, async () => {
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

test("an MCP server recovers on every update: the install's current link moves twice under one running server", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync('/tmp/sm-link-')
  const realIndex = new URL('../../host/lib/index.js', import.meta.url).href
  const realOperations = new URL('../../host/lib/operations.js', import.meta.url).href
  for (const n of [1, 2, 3]) {
    const lib = join(dir, 'releases', `r${n}`, 'packages', 'host', 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'index.js'), `export * from '${realIndex}'\nexport const VERSION = 'code-${n}'\n`)
    writeFileSync(join(lib, 'operations.js'), `export { operations } from '${realOperations}'\n`)
  }
  const move = (n: number) => {
    symlinkSync(`releases/r${n}`, join(dir, 'current.tmp'))
    renameSync(join(dir, 'current.tmp'), join(dir, 'current'))
  }
  move(1)
  mkdirSync(join(dir, 'system'))
  mkdirSync(join(dir, 'data'))
  const f = fixture()
  const host = await f.startHost(join(dir, 'data'))
  const methods = operations({ capabilities: f.capabilities, artifact: (id: string) => artifacts.get(id) } as Services)
  const listen = (n: number) => serve(host, { path: join(dir, 'system', 'host.sock'), methods, version: `code-${n}`, onDisk: () => `code-${n}` })
  let server = await listen(1)
  const client = new Client({ name: 'test', version: '0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env: { ...process.env, DSH_HOME: dir, SYSTEM_CODE: join(dir, 'current'), SYSTEM_OPERATOR_ID: 'o1' } as Record<string, string> })
  try {
    await client.connect(transport)
    for (const n of [1, 2, 3]) {
      if (n > 1) {
        move(n)
        await server.close()
        // The first call on the old connection (fl-7) reconnects, on the release the link now holds.
        server = await listen(n)
      }
      const listed = await call(client, 'work.list')
      assert.equal(listed.error, undefined, `release r${n}: ${listed.error}`)
      assert.deepEqual(listed.value, [])
    }
  } finally {
    await client.close()
    await server.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an MCP session refreshes its tools and notifies after recovering on newer Host code', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync('/tmp/sm-refresh-')
  const lib = join(dir, 'packages', 'host', 'lib')
  mkdirSync(lib, { recursive: true })
  const realIndex = new URL('../../host/lib/index.js', import.meta.url).href
  const realOperations = new URL('../../host/lib/operations.js', import.meta.url).href
  const extra = "'test.ping': { authority: 'caller', summary: 'ping', params: undefined, handler: () => 'pong' }"
  writeFileSync(join(lib, 'index.js'), `export * from '${realIndex}'\nexport const VERSION = 'newer-code'\n`)
  writeFileSync(join(lib, 'operations.js'), `import { operations as real } from '${realOperations}'\nexport const operations = (s) => ({ ...real(s), ${extra} })\n`)
  mkdirSync(join(dir, 'system'))
  const f = fixture()
  mkdirSync(join(dir, 'data'))
  const host = await f.startHost(join(dir, 'data'))
  const methods = operations({ capabilities: f.capabilities, artifact: (id: string) => artifacts.get(id) } as Services)
  const server = await serve(host, {
    path: join(dir, 'system', 'host.sock'),
    methods: { ...methods, 'test.ping': { authority: 'caller', summary: 'ping', params: undefined, handler: () => 'pong' } },
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

test('fl-7: the first call after the Host restarts reconnects and is sent again (a read, or a write with a commandId the MCP makes when the caller gave none)', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync('/tmp/sm-rs-')
  mkdirSync(join(dir, 'system'))
  mkdirSync(join(dir, 'data'))
  const f = fixture()
  const methods = operations({ capabilities: f.capabilities, artifact: (id: string) => artifacts.get(id) } as Services)
  let host = await f.startHost(join(dir, 'data'))
  let server = await serve(host, { path: join(dir, 'system', 'host.sock'), methods })
  const restart = async () => {
    await server.close()
    await host.close()
    host = await f.startHost(join(dir, 'data'))
    server = await serve(host, { path: join(dir, 'system', 'host.sock'), methods })
  }
  const client = new Client({ name: 'test', version: '0' })
  clients.push(client)
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp'], env: { ...process.env, DSH_HOME: dir, SYSTEM_OPERATOR_ID: 'o1' } as Record<string, string> }))
  const submit = { capabilities: ['repo.write'], run: false, commandId: 'c-restart' }
  const first = await call(client, 'work.submit', submit)
  assert.equal(first.error, undefined, first.error)
  // A read right after a restart succeeds on the first call.
  await restart()
  const listed = await call(client, 'work.list')
  assert.equal(listed.error, undefined, listed.error)
  assert.deepEqual((listed.value as { id: string }[]).map((w) => w.id), [first.value.id])
  // A write with commandId after a restart succeeds on the first call and is the same Work, once.
  await restart()
  const again = await call(client, 'work.submit', submit)
  assert.equal(again.error, undefined, again.error)
  assert.equal(again.value.id, first.value.id)
  assert.equal(((await call(client, 'work.list')).value as unknown[]).length, 1)
  // A write without commandId gets one from the MCP before the first send (mcp-1): it succeeds on the first call, as one more Work.
  await restart()
  const bare = await call(client, 'work.submit', { capabilities: ['repo.write'], run: false })
  assert.equal(bare.error, undefined, bare.error)
  assert.equal(((await call(client, 'work.list')).value as unknown[]).length, 2)
  await client.close()
  await server.close()
  await host.close()
  rmSync(dir, { recursive: true, force: true })
})

test('the bootstrap steps cite a section that exists in documentation-architecture.md', async () => {
  const { INSTRUCTIONS } = await import('../src/mcp.ts')
  assert.doesNotMatch(INSTRUCTIONS, /Appendix B/)
  assert.match(INSTRUCTIONS, /section 9, "Repository profile and agent\s+contract"/)
  assert.match(INSTRUCTIONS, /system bootstrap plan --repo <path>/)
  assert.match(INSTRUCTIONS, /system bootstrap check/)
  assert.match(INSTRUCTIONS, /STATUS\.md/)
  assert.match(INSTRUCTIONS, /Only a human approves/)
})

test('work.watch (MCP work_watch) names the same outcome as system work wait', { timeout: 120_000 }, async () => {
  const client = await mcp()
  const running = await call(client, 'work.submit', { workflow, run: false })
  assert.equal(running.error, undefined, running.error)
  const watchedRunning = await call(client, 'work.watch', { workId: running.value.id })
  assert.equal(watchedRunning.error, undefined, watchedRunning.error)
  assert.equal(watchedRunning.value.outcome, 'running')

  await call(client, 'work.run', { workId: running.value.id })
  await until('work to succeed', async () => (await call(client, 'work.show', { workId: running.value.id })).value.state.status === 'succeeded')
  const watchedDone = await call(client, 'work.watch', { workId: running.value.id })
  assert.equal(watchedDone.value.outcome, 'succeeded')

  const cancelled = await call(client, 'work.submit', { workflow, run: false })
  await call(client, 'work.cancel', { workId: cancelled.value.id, reason: 'stop' })
  const watchedCancelled = await call(client, 'work.watch', { workId: cancelled.value.id })
  assert.equal(watchedCancelled.value.outcome, 'cancelled')
})

const BOUND = 32 * 1024

test('alog-2: an MCP tool result over 32 KiB is cut with a marker; artifact.cat reads an Artifact in parts; work.show drops the oldest events', { timeout: 120_000 }, async () => {
  const client = await mcp()
  // An Artifact over the bound (its bytes are 100 KB of text lines).
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => `line ${String(i).padStart(5, '0')} of an attempt log\n`).join(''))
  assert.ok(bytes.length > 100_000)
  const stored = await call(client, 'artifact.put', { data: bytes.toString('base64'), mediaType: 'text/plain' })
  assert.equal(stored.error, undefined)
  const id = stored.value.id as string

  // With no arguments the first part comes back, within the bound, and says how to read on.
  const first = await call(client, 'artifact.cat', { id })
  assert.equal(first.error, undefined)
  assert.equal(first.value.size, bytes.length)
  assert.equal(first.value.offset, 0)
  const head = Buffer.from(first.value.data, 'base64')
  assert.ok(head.length > 0 && head.length < bytes.length)
  assert.deepEqual(head, bytes.subarray(0, head.length))
  // The parts put together are the whole Artifact.
  const parts = [head]
  while (Buffer.concat(parts).length < bytes.length) {
    const part = await call(client, 'artifact.cat', { id, offset: Buffer.concat(parts).length, maxBytes: 10_000 })
    assert.equal(part.error, undefined)
    parts.push(Buffer.from(part.value.data, 'base64'))
  }
  assert.deepEqual(Buffer.concat(parts), bytes)
  assert.deepEqual(Buffer.from((await call(client, 'artifact.cat', { id, offset: bytes.length - 5 })).value.data, 'base64'), bytes.subarray(bytes.length - 5))

  // A result over the bound that is not cut by its own tool is cut by the MCP server, with a marker line.
  const raw = await client.callTool({ name: 'artifact.cat', arguments: { id, maxBytes: 60_000 } }) as { isError?: boolean; content: { text: string }[] }
  const text = raw.content[0]!.text
  assert.ok(Buffer.byteLength(text) < BOUND + 512, `${Buffer.byteLength(text)} bytes`)
  const marker = text.split('\n').at(-1)!
  assert.match(marker, new RegExp(`${Buffer.byteLength(JSON.stringify(await human1.call('artifact.cat', { id })))}|\\d+ bytes`))
  assert.match(marker, /artifact\.cat/)
  assert.match(marker, /offset/)

  // The CLI path (the Host call itself) still gives everything.
  assert.deepEqual(Buffer.from(((await human1.call('artifact.cat', { id })) as { data: string }).data, 'base64'), bytes)

  // A Work whose record is over the bound: work.show drops the oldest events and says how many.
  const workId = (await call(client, 'work.submit', { capabilities: ['repo.write'], run: false })).value.id as string
  const reason = 'r'.repeat(20_000)
  // The cancel and the retry each record their reason as an event, and the retried Work runs to its end.
  const ok = async (name: string, args: Record<string, unknown>) => { const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] }; assert.notEqual(r.isError, true, r.content[0]!.text.slice(0, 300)) }
  await ok('work.cancel', { workId, reason })
  await ok('work.retry', { workId, step: 'task', reason })
  await until('the retried Work to end', async () => (await (human1.call('work.events', { workId }) as Promise<any>)).status === 'succeeded')
  const all = (await (human1.call('work.events', { workId }) as Promise<any>)).events as { seq: number }[]
  const full = await (human1.call('work.show', { workId }) as Promise<any>)
  assert.ok(JSON.stringify(full).length > BOUND, 'the fixture record is over the bound')
  const shown = await call(client, 'work.show', { workId })
  assert.equal(shown.error, undefined)
  assert.ok(JSON.stringify(shown.value).length <= BOUND)
  assert.ok(shown.value.omittedEvents > 0)
  assert.equal(shown.value.events.length + shown.value.omittedEvents, all.length)
  assert.deepEqual(shown.value.events.map((e: { seq: number }) => e.seq), all.slice(all.length - shown.value.events.length).map((e) => e.seq))
  assert.match(shown.value.omittedNote, /work\.events/)
  // The CLI path keeps every event.
  assert.equal(full.events.length, all.length)

  // work.trace is a caller operation, bounded at 32 KiB through MCP just like other tool results.
  const fullTrace = await (human1.call('work.trace', { workId }) as Promise<any>)
  assert.ok(JSON.stringify(fullTrace).length > BOUND, 'the fixture trace is over the bound')
  const rawTrace = await client.callTool({ name: 'work.trace', arguments: { workId } }) as { isError?: boolean; content: { text: string }[] }
  assert.notEqual(rawTrace.isError, true)
  const traceText = rawTrace.content[0]!.text
  assert.ok(Buffer.byteLength(traceText) < BOUND + 512, `${Buffer.byteLength(traceText)} bytes`)
  assert.match(traceText.split('\n').at(-1)!, /\[cut: the result is \d+ bytes/)
})
