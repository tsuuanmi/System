import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Artifacts } from '@system/artifacts'
import { GOAL_KIND, TASK_KIND, goalSchema, taskSchema } from '@system/work'
import { fixture, type Fixture } from '../../../test-support/fixture.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { NOT_ALLOWED, VERSION, connect, serve, tableOf, type Client } from '../src/index.ts'
import { operations, type Services } from '../src/operations.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-host-ops-'))
// A socket path is limited to about 100 bytes, and tmpdir() may be longer.
const sockets = mkdtempSync('/tmp/sh-')
after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(sockets, { recursive: true, force: true }) })
let count = 0
const human = { type: 'human', operatorId: 'tan' } as const
const agent = { type: 'agent', operatorId: 'a1' } as const
const orchestrator = (goal: string) => ({ type: 'orchestrator', operatorId: 'o1', goal }) as const
const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'workflows', 'brainstorm.yaml'), 'utf8')
const b64 = (text: string) => Buffer.from(text).toString('base64')

/** Services over in-memory stand-ins; what they were asked is recorded in `seen`. */
function services(f: Fixture, artifacts: Artifacts): Services & { seen: Record<string, unknown[]> } {
  const files = new Map<string, Uint8Array>()
  const seen: Record<string, unknown[]> = { credentials: [], conversations: [], goals: [], logins: [] }
  return {
    seen,
    capabilities: f.capabilities,
    async putFile(data, mediaType, classification, caller) {
      const id = `sha256:${Buffer.from(data).toString('hex').padEnd(64, '0').slice(0, 64)}`
      files.set(id, data)
      return { id, kind: 'file', mediaType, classification, producer: caller.operatorId }
    },
    artifact: (id) => (files.has(id) ? { state: 'stored', envelope: { id } } : artifacts.get(id)),
    async readBytes(id) {
      const data = files.get(id)
      if (!data) throw new Error(`no Artifact ${id}`)
      return data
    },
    async newTask(instructions, repository, ref, context) { return { task: `task:${instructions}:${repository ?? ''}:${ref ?? ''}:${context.join(',')}` } },
    async newGoal(goal, supersedes, caller) {
      seen.goals!.push({ goal, supersedes, caller })
      const producer = { type: 'operator', ref: caller.operatorId } as const
      const charter = await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: new TextEncoder().encode('charter'), mediaType: 'text/markdown', classification: 'public', producer })
      const stored = await artifacts.put({ ...GOAL_KIND, content: { context: [charter.id], ...goal }, inputs: [charter.id], supersedes: supersedes ? [supersedes] : [], classification: 'public', producer })
      return { id: stored.id }
    },
    async addConversation(parts, asserted, supersedes, caller) { seen.conversations!.push({ parts, asserted, supersedes, caller }); return { id: 'conversation:1' } },
    credentials: {
      async set(name, value) { seen.credentials!.push([name, value]) },
      async describe(name) { return name === 'known' ? { configured: true, source: 'store' } : { configured: false } },
    },
    async workers() { return { registered: f.capabilities.workerRefs(), accounts: [] } },
    async login(ref, cookies) { seen.logins!.push([ref, cookies]); return { signedIn: true, detail: 'signed in', imported: 1, skipped: 0 } },
  }
}

async function started(options: { f?: Fixture } = {}) {
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...GOAL_KIND, content: goalSchema })
  const f = options.f ?? fixture({ goals: artifacts })
  const home = join(dir, `n${count++}`)
  mkdirSync(home)
  const host = await f.startHost(home)
  const svc = services(f, artifacts)
  const table = operations(svc)
  const path = join(sockets, `${count++}.sock`)
  const server = await serve(host, { path, methods: table })
  after(async () => { await server.close(); await host.close() })
  const open = async (caller: { type: string; operatorId: string } = human): Promise<Client> => {
    const client = await connect(path)
    await client.call('host.hello', { version: VERSION, caller })
    after(() => client.close())
    return client
  }
  return { f, host, svc, table, open, path, artifacts }
}

const input = (f: Fixture) => f.admission('brainstorm.yaml').input!
const events = async (client: Client, workId: string, after?: number) => await client.call('work.events', { workId, after }) as { events: { seq: number; type: string; caller?: unknown }[]; status: string }
const terminal = async (client: Client, workId: string) => {
  let seq: number | undefined
  const seen: { seq: number; type: string; caller?: unknown }[] = []
  for (;;) {
    const page = await events(client, workId, seq)
    seen.push(...page.events)
    seq = seen.at(-1)?.seq
    if (page.status !== 'running') return { events: seen, status: page.status }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('every method of the table round-trips over the socket', async () => {
  const { f, svc, table, open, artifacts } = await started()
  const client = await open()
  const called = new Set<string>()
  const call = (method: string, params?: unknown) => { called.add(method); return client.call(method, params) }

  const task = await call('task.new', { instructions: 'do it', repository: '/r', ref: 'main', context: [`sha256:${'1'.repeat(64)}`] })
  assert.deepEqual(task, { task: `task:do it:/r:main:sha256:${'1'.repeat(64)}` })
  const put = await call('artifact.put', { data: b64('hello'), mediaType: 'text/plain', classification: 'local-private' }) as { id: string }
  assert.match(put.id, /^sha256:/)
  assert.equal((await call('artifact.show', { id: put.id }) as { state: string }).state, 'stored')
  assert.deepEqual(await call('artifact.cat', { id: put.id }), { data: b64('hello') })

  const work = await call('work.submit', { workflow, input: input(f), commandId: 'c-1' }) as { id: string; state: { status: string } }
  assert.equal(work.state.status, 'running')
  assert.deepEqual((await call('work.list') as { id: string }[]).map((r) => r.id), [work.id])
  assert.equal(((await call('work.show', { workId: work.id })) as { id: string }).id, work.id)
  assert.equal((await call('work.cancel', { workId: work.id, reason: 'stop' }) as { state: { status: string } }).state.status, 'cancelled')
  await call('work.retry', { workId: work.id, reason: 'again' })
  assert.equal((await terminal(client, work.id)).status, 'succeeded')
  assert.equal((await call('work.run', { workId: work.id }) as { state: { status: string } }).state.status, 'succeeded')
  assert.deepEqual(await call('work.replay', { workId: work.id }), { state: (await call('work.show', { workId: work.id }) as { state: unknown }).state, matches: true })
  assert.equal(((await call('work.report', { workId: work.id })) as { id?: string; attempts?: unknown }).attempts !== undefined, true)
  await assert.rejects(call('approval.decide', { workId: work.id, decision: 'approved', reason: 'ok' }), /nothing awaits a decision/)
  assert.deepEqual(await call('work.events', { workId: work.id, after: 1000 }), { events: [], status: 'succeeded' })

  const goal = await call('goal.new', { aim: 'ship', scope: 'the host', budget: { attempts: 1 } }) as { id: string }
  const goalTask = await artifacts.put({ ...TASK_KIND, content: { instructions: 'do it' }, classification: 'public', producer: { type: 'operator', ref: 'tan' } })
  const goaled = await call('work.submit', { capabilities: ['code-write'], input: goalTask.id, goal: goal.id }) as { id: string; events: { type: string; goal?: string }[] }
  assert.equal(goaled.events[0]!.goal, goal.id)
  await call('work.run', { workId: goaled.id })
  assert.equal((await terminal(client, goaled.id)).status, 'succeeded')
  const shownGoal = await call('goal.show', { goal: goal.id }) as { id: string; current: { id: string }; spend: { attempts: number } }
  assert.deepEqual([shownGoal.id, shownGoal.current.id, shownGoal.spend.attempts], [goal.id, goal.id, 1])
  const goalReport = await call('work.report', { workId: goaled.id }) as { goal: { id: string; spend: { attempts: number }; budget: unknown } }
  assert.deepEqual([goalReport.goal.id, goalReport.goal.spend.attempts, goalReport.goal.budget], [goal.id, 1, { attempts: 1 }])
  await assert.rejects(call('work.submit', { capabilities: ['code-write'], input: goalTask.id, goal: goal.id }), /budget/)
  const raised = await call('goal.new', { aim: 'ship', scope: 'the host', budget: { attempts: 2 }, supersedes: goal.id }) as { id: string }
  assert.equal((await call('goal.show', { goal: goal.id }) as { current: { id: string } }).current.id, raised.id)
  await call('work.submit', { capabilities: ['code-write'], input: goalTask.id, goal: goal.id })
  await assert.rejects(call('goal.show', { goal: `sha256:${'8'.repeat(64)}` }), /no Goal/)

  const second = await call('work.submit', { capabilities: ['code-write'], input: input(f) }) as { id: string }
  await call('work.run', { workId: second.id })
  assert.equal((await terminal(client, second.id)).status, 'succeeded')

  const parts = { response: { name: 'r.md', data: b64('an answer'), mediaType: 'text/markdown' }, attachments: [] }
  const preview = await call('conversation.preview', { parts }) as { parts: { role: string }[]; warnings: string[] }
  assert.deepEqual(preview.parts.map((p) => p.role), ['response'])
  assert.deepEqual(await call('conversation.add', { parts, asserted: { provider: 'web' }, supersedes: [] }), { id: 'conversation:1' })

  assert.deepEqual((await call('workers.list') as { registered: string[] }).registered, ['fake/claude', 'fake/codex'])
  assert.deepEqual(await call('workers.login', { ref: 'chatgpt-web/default', cookies: 'the file' }), { signedIn: true, detail: 'signed in', imported: 1, skipped: 0 })
  assert.deepEqual(svc.seen.logins, [['chatgpt-web/default', 'the file']])
  await call('credentials.set', { name: 'known', value: 's3cret' })
  assert.deepEqual(await call('credentials.status', { names: ['known', 'other'] }), [{ name: 'known', configured: true, source: 'store' }, { name: 'other', configured: false }])
  const status = await call('host.status') as { works: number; recordBytes: number }
  assert.equal(status.works, 4)
  assert.ok(status.recordBytes > 0)

  assert.deepEqual([...called].sort(), Object.keys(tableOf(table)).sort(), 'a method of the table has no round trip in this test')
})

test('an agent connection is refused every method flagged agent: false, and only those', async () => {
  const { table, open } = await started()
  const client = await open(agent)
  const closed = Object.entries(tableOf(table)).filter(([, m]) => !m.agent).map(([name]) => name)
  assert.ok(closed.includes('approval.decide') && closed.includes('credentials.set') && closed.includes('conversation.add') && closed.includes('workers.login'))
  for (const [name, method] of Object.entries(tableOf(table))) {
    const outcome = await client.call(name, {}).then(() => undefined, (error: { code: number; message: string }) => error)
    if (method.agent) assert.notEqual(outcome?.code, NOT_ALLOWED, `${name} is open to agents`)
    else {
      assert.equal(outcome?.code, NOT_ALLOWED, `${name} must refuse an agent`)
      assert.match(outcome!.message, /not allowed for agents/)
    }
  }
})

test('goal.new is refused to an agent connection, and nothing is stored', async () => {
  const { open, svc } = await started()
  const client = await open(agent)
  await assert.rejects(client.call('goal.new', { aim: 'a', scope: 's', budget: {} }), (error: { code: number }) => error.code === NOT_ALLOWED)
  assert.deepEqual(svc.seen.goals, [])
  // The row is open to a human, and its handler checks again.
  const { host, table } = await started()
  await assert.rejects(async () => table['goal.new']!.handler(host, { aim: 'a', scope: 's', budget: {} }, agent), /human/)
})

test('approval.decide needs a human even when its row is opened to agents', async () => {
  const { host, table } = await started()
  const decide = table['approval.decide']!
  await assert.rejects(async () => decide.handler(host, { workId: 'work:x', decision: 'approved', reason: 'ok' }, agent), /human/)
})

test('a malformed or unknown param is refused with -32602 before the handler', async () => {
  const { open } = await started()
  const client = await open()
  for (const [method, params] of [['work.show', {}], ['work.show', { workId: 1 }], ['work.submit', {}], ['work.submit', { workflow: 'x', capabilities: ['a'] }], ['artifact.put', { data: '%%%', mediaType: 'x', classification: 'local-private' }], ['work.events', { workId: 'w', after: -2 }]] as const) {
    await assert.rejects(client.call(method, params), (error: { code: number }) => error.code === -32602, `${method} ${JSON.stringify(params)}`)
  }
})

test('the same work.submit with the same commandId gives one Work, and another body is refused', async () => {
  const { f, open } = await started()
  const client = await open()
  const params = { workflow, input: input(f), commandId: 'lost-reply' }
  const [a, b] = await Promise.all([client.call('work.submit', params), client.call('work.submit', params)]) as { id: string }[]
  const again = await client.call('work.submit', params) as { id: string }
  assert.equal(a!.id, b!.id)
  assert.equal(again.id, a!.id)
  assert.equal((await client.call('work.list') as unknown[]).length, 1)
  await assert.rejects(client.call('work.submit', { ...params, capabilities: undefined, workflow: workflow.replace('version: 2', 'version: 3') }), /different arguments/)
})

test('work.events with a cursor returns only newer events, and the current status', async () => {
  const { f, open } = await started()
  const client = await open()
  const { id } = await client.call('work.submit', { workflow, input: input(f) }) as { id: string }
  await client.call('work.run', { workId: id })
  const all = await terminal(client, id)
  const from = all.events[2]!.seq
  const page = await events(client, id, from)
  assert.deepEqual(page.events.map((e) => e.seq), all.events.map((e) => e.seq).filter((seq) => seq > from))
  assert.equal(page.status, 'succeeded')
  assert.deepEqual((await events(client, id)).events.map((e) => e.seq), all.events.map((e) => e.seq))
})

test('submit, then work.events until terminal, matches work.show', async () => {
  const { f, open } = await started()
  const client = await open()
  const { id } = await client.call('work.submit', { workflow, input: input(f) }) as { id: string }
  await client.call('work.run', { workId: id })
  const followed = await terminal(client, id)
  const shown = await client.call('work.show', { workId: id }) as { events: unknown[]; state: { status: string } }
  assert.deepEqual(followed.events, shown.events)
  assert.equal(followed.status, shown.state.status)
})

test('work.run returns once the Work is running, not when it ends; closing the client does not cancel it', async () => {
  const { f, open } = await started()
  f.hold('idea-a')
  const first = await open()
  const { id } = await first.call('work.submit', { workflow, input: input(f) }) as { id: string }
  const run = await first.call('work.run', { workId: id }) as { state: { status: string } }
  assert.equal(run.state.status, 'running')
  await f.arrived('idea-a')
  first.close()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = await open()
  assert.equal((await events(second, id)).status, 'running')
  f.release('idea-a')
  const done = await terminal(second, id)
  assert.equal(done.status, 'succeeded')
  assert.ok(!done.events.some((e) => e.type === 'terminal' && (e as { outcome?: string }).outcome === 'cancelled'))
  assert.equal(f.attempts.filter((s) => s === 'idea-a').length, 1)
})

test('a second work.run of a running Work is refused at once, not after it ends', async () => {
  const { f, open } = await started()
  f.hold('idea-a')
  const client = await open()
  const { id } = await client.call('work.submit', { workflow, input: input(f) }) as { id: string }
  await client.call('work.run', { workId: id })
  await f.arrived('idea-a')
  await assert.rejects(client.call('work.run', { workId: id }), /./)
  f.release('idea-a')
  assert.equal((await terminal(client, id)).status, 'succeeded')
})

test('the connection\'s caller is recorded on every Work event a call causes', async () => {
  const { f, open } = await started()
  const agentClient = await open(agent)
  const { id } = await agentClient.call('work.submit', { workflow, input: input(f) }) as { id: string }
  await agentClient.call('work.cancel', { workId: id, reason: 'stop' })
  const humanClient = await open({ type: 'human', operatorId: 'sam' })
  await humanClient.call('work.retry', { workId: id, reason: 'again' })
  const done = await terminal(humanClient, id)
  const by = (type: string) => done.events.find((e) => e.type === type)?.caller
  assert.deepEqual(by('admitted'), agent)
  assert.deepEqual(done.events.filter((e) => e.type === 'terminal').map((e) => e.caller).slice(0, 1), [agent])
  assert.deepEqual(by('reopened'), { type: 'human', operatorId: 'sam' })
})

test('a missing Work or Artifact is an error, not a crash', async () => {
  const { open } = await started()
  const client = await open()
  await assert.rejects(client.call('work.show', { workId: 'work:none' }), /no Work work:none/)
  await assert.rejects(client.call('work.events', { workId: 'work:none' }), /no Work work:none/)
  await assert.rejects(client.call('artifact.cat', { id: `sha256:${'0'.repeat(64)}` }), /no Artifact/)
  assert.equal((await client.call('host.status') as { works: number }).works, 0)
})

test('conversation.add refuses a preview with warnings unless acceptWarnings', async () => {
  const { svc, open } = await started()
  const client = await open()
  const parts = { response: { name: 'r.md', data: b64('my password: hunter2hunter2'), mediaType: 'text/markdown' } }
  await assert.rejects(client.call('conversation.add', { parts, asserted: {}, supersedes: [] }), /the preview has warnings/)
  assert.equal(svc.seen.conversations!.length, 0)
  await client.call('conversation.add', { parts, asserted: {}, supersedes: [], acceptWarnings: true })
  assert.equal(svc.seen.conversations!.length, 1)
})

test('the same work.run with the same commandId while it runs answers at once and drives it once', async () => {
  const { f, open } = await started()
  f.hold('idea-a')
  const client = await open()
  const { id } = await client.call('work.submit', { workflow, input: input(f) }) as { id: string }
  const first = await client.call('work.run', { workId: id, commandId: 'run-1' }) as { state: { status: string } }
  await f.arrived('idea-a')
  const again = await client.call('work.run', { workId: id, commandId: 'run-1' }) as { state: { status: string } }
  assert.equal(first.state.status, 'running')
  assert.equal(again.state.status, 'running')
  f.release('idea-a')
  assert.equal((await terminal(client, id)).status, 'succeeded')
  assert.equal(f.attempts.filter((s) => s === 'idea-a').length, 1)
})

test('an orchestrator connection is refused what an agent is refused, and is never listed more', async () => {
  const { table, open } = await started()
  const client = await open(orchestrator(`sha256:${'a'.repeat(64)}`))
  for (const [name, method] of Object.entries(tableOf(table))) {
    if (method.agent) continue
    const outcome = await client.call(name, {}).then(() => undefined, (error: { code: number; message: string }) => error)
    assert.equal(outcome?.code, NOT_ALLOWED, `${name} must refuse an orchestrator`)
  }
  for (const name of ['approval.decide', 'credentials.set', 'conversation.add', 'goal.new']) assert.equal(table[name]!.agent, false)
})

test('a hello of type orchestrator needs a goal, and an agent hello has none', async () => {
  const { path } = await started()
  const client = await connect(path)
  await assert.rejects(client.call('host.hello', { version: VERSION, caller: { type: 'orchestrator', operatorId: 'o1' } }), (error: { code: number }) => error.code === -32602)
  await assert.rejects(client.call('host.hello', { version: VERSION, caller: { type: 'orchestrator', operatorId: 'o1', goal: 'not an id' } }), (error: { code: number }) => error.code === -32602)
  client.close()
})

test('an orchestrator reaches only the Works of its Goal, and the Artifacts of those Works', async () => {
  const { artifacts, open } = await started()
  const human = await open()
  const goal = async (aim: string, supersedes?: string) => (await human.call('goal.new', { aim, scope: 's', budget: {}, supersedes }) as { id: string }).id
  const [a, b] = [await goal('a'), await goal('b')]
  const task = async (text: string) => (await artifacts.put({ ...TASK_KIND, content: { instructions: text }, classification: 'public', producer: { type: 'operator', ref: 'tan' } })).id
  const submit = async (goalId: string | undefined, text: string) => await human.call('work.submit', { capabilities: ['code-write'], input: await task(text), goal: goalId }) as { id: string; events: { input: string }[] }
  const [workA, workB, workN] = [await submit(a, 'one'), await submit(b, 'two'), await submit(undefined, 'three')]
  const ours = await open(orchestrator(a))
  const scoped = (call: Promise<unknown>) => assert.rejects(call, (error: { code: number; message: string }) => error.code === NOT_ALLOWED && /scope/.test(error.message))

  assert.deepEqual((await ours.call('work.list') as { id: string }[]).map((r) => r.id), [workA.id])
  assert.equal((await ours.call('work.show', { workId: workA.id }) as { id: string }).id, workA.id)
  for (const other of [workB, workN]) {
    await scoped(ours.call('work.show', { workId: other.id }))
    await scoped(ours.call('work.events', { workId: other.id }))
    await scoped(ours.call('work.report', { workId: other.id }))
    await scoped(ours.call('work.replay', { workId: other.id }))
    await scoped(ours.call('work.run', { workId: other.id }))
    await scoped(ours.call('work.retry', { workId: other.id }))
    await scoped(ours.call('work.cancel', { workId: other.id }))
    await scoped(ours.call('artifact.show', { id: other.events[0]!.input }))
    await scoped(ours.call('artifact.cat', { id: other.events[0]!.input }))
  }
  assert.equal((await human.call('work.show', { workId: workB.id }) as { state: { status: string } }).state.status, 'running')

  const shown = await ours.call('artifact.show', { id: workA.events[0]!.input }) as { state: string }
  assert.equal(shown.state, 'stored')
  const context = (shown as unknown as { envelope: { content: { context: string[] } } }).envelope.content.context
  assert.equal((await ours.call('artifact.show', { id: context[0] }) as { state: string }).state, 'stored')
  await scoped(ours.call('artifact.show', { id: `sha256:${'5'.repeat(64)}` }))

  await ours.call('work.run', { workId: workA.id })
  assert.equal((await terminal(ours, workA.id)).status, 'succeeded')
  const outputs = Object.values((await ours.call('work.show', { workId: workA.id }) as { state: { results: Record<string, string> } }).state.results)
  for (const id of outputs) assert.notEqual(await ours.call('artifact.show', { id }).then(() => 'ok', (error: { code: number }) => error.code), NOT_ALLOWED)

  const filled = await ours.call('work.submit', { capabilities: ['code-write'], input: await task('four') }) as { id: string; events: { goal?: string; caller: unknown }[] }
  assert.equal(filled.events[0]!.goal, a)
  assert.deepEqual(filled.events[0]!.caller, orchestrator(a))
  await ours.call('work.submit', { capabilities: ['code-write'], input: await task('five'), goal: a })
  await scoped(ours.call('work.submit', { capabilities: ['code-write'], input: await task('six'), goal: b }))
  assert.equal((await ours.call('work.list') as unknown[]).length, 3)

  // A raise of the Goal keeps the Works of the whole chain in scope, for the old and the new ID.
  const raised = await goal('a again', a)
  const later = await human.call('work.submit', { capabilities: ['code-write'], input: await task('seven'), goal: raised }) as { id: string }
  assert.ok((await ours.call('work.list') as { id: string }[]).some((r) => r.id === later.id))
  const newer = await open(orchestrator(raised))
  assert.ok((await newer.call('work.list') as { id: string }[]).some((r) => r.id === workA.id))
  await scoped(newer.call('work.show', { workId: workB.id }))
})
