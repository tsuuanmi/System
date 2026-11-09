import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Artifacts } from '@system/artifacts'
import { DECISION_KIND, GOAL_KIND, TASK_KIND, decisionSchema, goalSchema, goalStore, taskSchema } from '@system/work'
import { fixture, workflowFile, type Fixture } from '../../../test-support/fixture.ts'
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
  const goals = goalStore(artifacts)
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
    workflowFile: (name) => { try { return workflowFile(name) } catch { return undefined } },
    addDecision: (decision, caller) => goals.decide(decision, caller),
    decisions: (chain) => goals.decisions(chain),
    async addConversation(parts, asserted, supersedes, caller) { seen.conversations!.push({ parts, asserted, supersedes, caller }); return { id: 'conversation:1' } },
    credentials: {
      async set(name, value) { seen.credentials!.push([name, value]) },
      async describe(name) { return name === 'known' ? { configured: true, source: 'store' } : { configured: false } },
    },
    async workers() { return { registered: f.capabilities.workerRefs(), accounts: [] } },
    async login(ref, cookies) { seen.logins!.push([ref, cookies]); return { signedIn: true, detail: 'signed in', imported: 1, skipped: 0 } },
    async loginRemote(ref) { seen.logins!.push([ref, 'remote']); return { url: 'http://127.0.0.1:5/token/', port: 5, ssh: 'ssh -L 5:127.0.0.1:5 me@host', expiresAt: 1 } },
    async recheck(ref) { seen.logins!.push([ref, 'recheck']); return { ready: false, state: 'needs-sign-in', detail: 'signed out' } },
    async loginWait(ref, cancel) { seen.logins!.push([ref, cancel ? 'cancel' : 'wait']); return { signedIn: !cancel, detail: cancel ? 'cancelled' : 'signed in' } },
  }
}

async function started(options: { setup?: (f: Fixture) => void; stallMinutes?: number } = {}) {
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...GOAL_KIND, content: goalSchema }, { ...DECISION_KIND, content: decisionSchema })
  const f = fixture({ goals: artifacts })
  options.setup?.(f)
  const home = join(dir, `n${count++}`)
  mkdirSync(home)
  const host = await f.startHost(home, { stallMinutes: options.stallMinutes })
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
  assert.deepEqual(await call('work.watch', { workId: work.id }), { status: 'running', seq: 0 })
  assert.deepEqual(await call('work.unwatch', { workId: work.id }), { status: 'running', seq: 0 })
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
  const decided = await call('decision.add', { goal: goal.id, question: 'which?', options: ['a', 'b'], choice: 'a', reason: 'cheaper' }) as { id: string }
  assert.deepEqual((await call('decision.list', { goal: goal.id }) as { id: string }[]).map((d) => d.id), [decided.id])
  assert.match((await call('goal.brief', { goal: goal.id }) as { text: string }).text, new RegExp(decided.id))

  const second = await call('work.submit', { capabilities: ['code-write'], input: input(f) }) as { id: string }
  await call('work.run', { workId: second.id })
  assert.equal((await terminal(client, second.id)).status, 'succeeded')

  const pinned = await call('work.submit', { capabilities: ['code-write'], input: input(f), worker: 'fake/claude' }) as { id: string; events: { type: string; worker?: string }[] }
  assert.equal(pinned.events[0]!.worker, 'fake/claude')
  await assert.rejects(call('work.submit', { capabilities: ['code-write'], input: input(f), worker: 'nobody/default' }), /no enabled Worker nobody\/default/)
  await assert.rejects(call('work.submit', { capabilities: ['code-write'], input: input(f), worker: 'fake/codex' }), /fake\/codex does not provide code-write/)

  const parts = { response: { name: 'r.md', data: b64('an answer'), mediaType: 'text/markdown' }, attachments: [] }
  const preview = await call('conversation.preview', { parts }) as { parts: { role: string }[]; warnings: string[] }
  assert.deepEqual(preview.parts.map((p) => p.role), ['response'])
  assert.deepEqual(await call('conversation.add', { parts, asserted: { provider: 'web' }, supersedes: [] }), { id: 'conversation:1' })

  assert.deepEqual((await call('workers.list') as { registered: string[] }).registered, ['fake/claude', 'fake/codex'])
  assert.deepEqual(await call('workers.login', { ref: 'web/chatgpt/default', cookies: 'the file' }), { signedIn: true, detail: 'signed in', imported: 1, skipped: 0 })
  assert.deepEqual(svc.seen.logins, [['web/chatgpt/default', 'the file']])
  assert.deepEqual(await call('workers.loginRemote', { ref: 'web/chatgpt/default' }), { url: 'http://127.0.0.1:5/token/', port: 5, ssh: 'ssh -L 5:127.0.0.1:5 me@host', expiresAt: 1 })
  assert.deepEqual(await call('workers.loginWait', { ref: 'web/chatgpt/default' }), { signedIn: true, detail: 'signed in' })
  assert.deepEqual(await call('workers.loginWait', { ref: 'web/chatgpt/default', cancel: true }), { signedIn: false, detail: 'cancelled' })
  assert.deepEqual(svc.seen.logins!.slice(1), [['web/chatgpt/default', 'remote'], ['web/chatgpt/default', 'wait'], ['web/chatgpt/default', 'cancel']])
  assert.deepEqual(await call('workers.recheck', { ref: 'web/chatgpt/default' }), { ready: false, state: 'needs-sign-in', detail: 'signed out' })
  assert.deepEqual(svc.seen.logins!.at(-1), ['web/chatgpt/default', 'recheck'])
  await call('credentials.set', { name: 'known', value: 's3cret' })
  assert.deepEqual(await call('credentials.status', { names: ['known', 'other'] }), [{ name: 'known', configured: true, source: 'store' }, { name: 'other', configured: false }])
  const status = await call('host.status') as { works: number; recordBytes: number }
  assert.equal(status.works, 5)
  assert.ok(status.recordBytes > 0)

  assert.deepEqual([...called].sort(), Object.keys(tableOf(table)).sort(), 'a method of the table has no round trip in this test')
})

test('an agent connection is refused every method flagged agent: false, and only those', async () => {
  const { table, open } = await started()
  const client = await open(agent)
  const closed = Object.entries(tableOf(table)).filter(([, m]) => !m.agent).map(([name]) => name)
  assert.ok(closed.includes('approval.decide') && closed.includes('credentials.set') && closed.includes('conversation.add') && closed.includes('workers.login') && closed.includes('workers.loginRemote') && closed.includes('workers.loginWait') && closed.includes('workers.recheck'))
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
  await assert.rejects(async () => table['goal.new']!.handler(host, { aim: 'a', scope: 's', budget: {} }, agent, undefined as never), /human/)
})

test('approval.decide needs a human even when its row is opened to agents', async () => {
  const { host, table } = await started()
  const decide = table['approval.decide']!
  await assert.rejects(async () => decide.handler(host, { workId: 'work:x', decision: 'approved', reason: 'ok' }, agent, undefined as never), /human/)
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

type Notice = { workId: string; status: string; seq: number; stalled?: boolean }

/** A connection that keeps the `work.changed` notices it is sent. */
async function listening(open: (caller?: { type: string; operatorId: string }) => Promise<Client>, caller?: { type: string; operatorId: string }) {
  const client = await open(caller)
  const notices: Notice[] = []
  client.onNotice((method, params) => { assert.equal(method, 'work.changed'); notices.push(params as Notice) })
  return { client, notices }
}

const settled = async (what: string, ok: () => boolean) => {
  for (const end = Date.now() + 20_000; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (ok()) return
  assert.fail(`timed out waiting for ${what}`)
}

const heldWorkflow = `${workflowFile('software-engineering.yaml')}      approval: operator\n`
const seUses = { 'code-checks.yaml': workflowFile('code-checks.yaml') }

test('work.watch sends one work.changed when the Work finishes, and one when it is held', { timeout: 60_000 }, async () => {
  const { f, open } = await started()
  const { client, notices } = await listening(open)
  const done = await client.call('work.submit', { workflow, input: input(f) }) as { id: string }
  assert.deepEqual(await client.call('work.watch', { workId: done.id }), { status: 'running', seq: 0 })
  await client.call('work.run', { workId: done.id })
  await settled('the notice', () => notices.length > 0)
  const last = (await events(client, done.id)).events.at(-1)!
  assert.deepEqual(notices, [{ workId: done.id, status: 'succeeded', seq: last.seq }])

  const held = await client.call('work.submit', { workflow: heldWorkflow, uses: seUses, input: input(f) }) as { id: string }
  await client.call('work.watch', { workId: held.id })
  await client.call('work.run', { workId: held.id })
  await settled('the held notice', () => notices.length > 1)
  assert.equal(notices[1]!.status, 'held')
  assert.equal(notices[1]!.workId, held.id)
  // Approving it is the next change of the same Work: one more notice, the end.
  const approver = await open()
  await approver.call('approval.decide', { workId: held.id, decision: 'approved', reason: 'ok' })
  await settled('the end after approval', () => notices.length > 2)
  assert.deepEqual([notices[2]!.status, notices.length], ['succeeded', 3])
})

test('work.unwatch stops the notices; a watch on another Work is not heard', { timeout: 60_000 }, async () => {
  const { f, open } = await started()
  const quiet = await listening(open)
  const loud = await listening(open)
  const work = await quiet.client.call('work.submit', { workflow, input: input(f) }) as { id: string }
  const other = await quiet.client.call('work.submit', { workflow, input: input(f) }) as { id: string }
  await quiet.client.call('work.watch', { workId: work.id })
  await quiet.client.call('work.watch', { workId: other.id })
  await loud.client.call('work.watch', { workId: work.id })
  await quiet.client.call('work.unwatch', { workId: work.id })
  await quiet.client.call('work.run', { workId: work.id })
  // The other connection's notice is sent in the same step as the one that was not.
  await settled('the notice', () => loud.notices.length > 0)
  assert.deepEqual(quiet.notices, [])
  await quiet.client.call('work.run', { workId: other.id })
  await settled('the other notice', () => quiet.notices.length > 0)
  assert.deepEqual((quiet.notices as Notice[]).map((n) => n.workId), [other.id])
  await assert.rejects(quiet.client.call('work.watch', { workId: 'work:nope' }), /no Work work:nope/)
})

test('a closed connection drops its watches', { timeout: 60_000 }, async () => {
  const { f, host, open } = await started()
  let live = 0
  const real = host.onChange.bind(host)
  host.onChange = (listener) => { live++; const stop = real(listener); return () => { live--; stop() } }
  const gone = await open()
  const work = await gone.call('work.submit', { workflow, input: input(f) }) as { id: string }
  await gone.call('work.watch', { workId: work.id })
  assert.equal(live, 1)
  gone.close()
  await settled('the watches to drop', () => live === 0)
  const next = await open()
  await next.call('work.run', { workId: work.id })
  assert.equal((await terminal(next, work.id)).status, 'succeeded')
})

test('a client that missed the notice reads on from its cursor and loses nothing', { timeout: 60_000 }, async () => {
  const { f, open } = await started()
  const away = await listening(open)
  const work = await away.client.call('work.submit', { workflow, input: input(f) }) as { id: string }
  await away.client.call('work.watch', { workId: work.id })
  const cursor = (await events(away.client, work.id)).events.at(-1)!.seq
  away.client.close()
  // Nobody is connected when the Work ends, so no notice reaches anyone.
  const other = await open()
  await other.call('work.run', { workId: work.id })
  assert.equal((await terminal(other, work.id)).status, 'succeeded')
  assert.deepEqual(away.notices, [])

  const back = await open()
  const missed = await events(back, work.id, cursor)
  const all = await events(back, work.id)
  assert.equal(missed.status, 'succeeded')
  assert.deepEqual(missed.events.map((e) => e.seq), all.events.slice(cursor + 1).map((e) => e.seq))
  assert.equal(missed.events.at(-1)!.type, 'terminal')
  assert.equal(missed.events.length, all.events.length - cursor - 1)
  // Watching a Work that already ended says so in the reply, which is the same wake-up.
  assert.deepEqual(await back.call('work.watch', { workId: work.id }), { status: 'succeeded', seq: all.events.at(-1)!.seq })
})

test('work.watch by goal tells of each new Work of the Goal, and an orchestrator watches only its own', { timeout: 60_000 }, async () => {
  const { open, artifacts } = await started()
  const human1 = await open()
  const [a, b] = [(await human1.call('goal.new', { aim: 'a', scope: 's' }) as { id: string }).id, (await human1.call('goal.new', { aim: 'b', scope: 's' }) as { id: string }).id]
  const input = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'do it' }, classification: 'public', producer: { type: 'operator', ref: 'tan' } })).id
  const orch = await listening(open, orchestrator(a))
  await orch.client.call('work.watch', { goal: a })
  await assert.rejects(orch.client.call('work.watch', { goal: b }), (error: { code: number }) => error.code === NOT_ALLOWED)
  await assert.rejects(orch.client.call('work.watch', {}), /exactly one of workId and goal/)
  const mine = await human1.call('work.submit', { capabilities: ['code-write'], goal: a, input }) as { id: string }
  await human1.call('work.submit', { capabilities: ['code-write'], goal: b, input })
  const free = await human1.call('work.submit', { capabilities: ['code-write'] }) as { id: string }
  await settled('the admission notice', () => orch.notices.length > 0)
  await human1.call('work.run', { workId: free.id })
  await terminal(human1, free.id)
  assert.deepEqual(orch.notices, [{ workId: mine.id, status: 'running', seq: 0 }])
  await assert.rejects(orch.client.call('work.watch', { workId: free.id }), (error: { code: number }) => error.code === NOT_ALLOWED)
  await orch.client.call('work.unwatch', { goal: a })
  await human1.call('work.submit', { capabilities: ['code-write'], goal: a, input })
  await human1.call('work.run', { workId: mine.id })
  await terminal(human1, mine.id)
  assert.equal(orch.notices.length, 1)
})

test('a decision names its Goal: an orchestrator records only for its own, and decision.list returns them in order', async () => {
  const { open, artifacts } = await started()
  const human = await open()
  const goal = async (aim: string, supersedes?: string) => (await human.call('goal.new', { aim, scope: 's', budget: {}, supersedes }) as { id: string }).id
  const [a, b] = [await goal('a'), await goal('b')]
  const synthesis = (await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: new TextEncoder().encode('the synthesis'), mediaType: 'text/plain', classification: 'public', producer: { type: 'operator', ref: 'tan' } })).id
  const ours = await open(orchestrator(a))
  const scoped = (call: Promise<unknown>) => assert.rejects(call, (error: { code: number; message: string }) => error.code === NOT_ALLOWED && /scope/.test(error.message))
  const ask = { question: 'which direction?', options: ['x', 'y'], choice: 'x', reason: 'the synthesis favours it' }

  const first = await ours.call('decision.add', { ...ask, restsOn: [synthesis] }) as { id: string }
  const stored = artifacts.get(first.id)
  assert.equal(stored.state, 'stored')
  const content = (stored as { envelope: { kind: string; content: { goal: string; by: unknown; restsOn: string[] } } }).envelope
  assert.deepEqual([content.kind, content.content.goal, content.content.by, content.content.restsOn], ['decision', a, orchestrator(a), [synthesis]])
  await scoped(ours.call('decision.add', { ...ask, goal: b }))
  await assert.rejects(ours.call('decision.add', { ...ask, choice: 'z' }), /choice z is not one of the options/)
  await assert.rejects(human.call('decision.add', ask), /needs the Goal/)
  await assert.rejects(human.call('decision.add', { ...ask, goal: `sha256:${'8'.repeat(64)}` }), /no Goal/)

  // The same question asked again is a second decision, after the first.
  const second = await human.call('decision.add', { ...ask, goal: a }) as { id: string }
  const other = await human.call('decision.add', { ...ask, goal: b }) as { id: string }
  const raised = await goal('a again', a)
  const third = await (await open(orchestrator(raised))).call('decision.add', { ...ask, choice: 'y', reason: 'changed course' }) as { id: string }
  const ids = (list: unknown) => (list as { id: string }[]).map((d) => d.id)
  assert.deepEqual(ids(await ours.call('decision.list', {})), [first.id, second.id, third.id])
  assert.deepEqual(ids(await human.call('decision.list', { goal: a })), [first.id, second.id, third.id])
  assert.deepEqual(ids(await human.call('decision.list', { goal: b })), [other.id])
  assert.equal((await human.call('decision.list', {}) as unknown[]).length, 4)
  await scoped(ours.call('decision.list', { goal: b }))
  const listed = (await ours.call('decision.list', {}) as { choice: string; previous?: string; at: string }[])
  assert.deepEqual(listed.map((d) => [d.choice, d.previous]), [['x', undefined], ['x', first.id], ['y', second.id]])
})

test('a running attempt shows its progress in work.show, and a quiet one sends a stall notice; the record keeps neither', { timeout: 60_000 }, async () => {
  let twoTurns!: () => void
  const reported = new Promise<void>((resolve) => { twoTurns = resolve })
  const { open } = await started({ stallMinutes: 0.005, setup: (f) => f.capabilities.registerWorker({
    ref: 'fake/quiet', capabilities: ['quiet-work'],
    async run(request) {
      request.progress?.({ turns: 1, lastTool: 'Bash', tokens: 10 })
      request.progress?.({ turns: 2, lastTool: 'Read', tokens: 25 })
      twoTurns()
      // Then nothing more, until it is cancelled.
      await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }))
      return { status: 'cancelled', outputs: {} }
    },
  }) })
  const { client, notices } = await listening(open)
  const work = await client.call('work.submit', { capabilities: ['quiet-work'] }) as { id: string }
  await client.call('work.watch', { workId: work.id })
  await client.call('work.run', { workId: work.id })
  await reported
  type Live = { stepId: string; attemptId: string; worker: string; startedAt: string; lastActivityAt: string; elapsedSeconds: number; quietSeconds: number; stalled: boolean; progress: unknown }
  const shown = await client.call('work.show', { workId: work.id }) as { live: Live[]; events: { type: string }[] }
  assert.equal(shown.live.length, 1)
  assert.deepEqual([shown.live[0]!.stepId, shown.live[0]!.worker, shown.live[0]!.progress], ['task', 'fake/quiet', { turns: 2, lastTool: 'Read', tokens: 25 }])
  assert.ok(shown.live[0]!.lastActivityAt >= shown.live[0]!.startedAt)

  await settled('the stall notice', () => notices.some((n) => n.stalled))
  const seq = (await events(client, work.id)).events.at(-1)!.seq
  assert.deepEqual(notices, [{ workId: work.id, status: 'running', seq, stalled: true }])
  const stalled = await client.call('work.show', { workId: work.id }) as { live: Live[] }
  assert.equal(stalled.live[0]!.stalled, true)

  await client.call('work.cancel', { workId: work.id, reason: 'quiet too long' })
  await settled('the end', () => notices.some((n) => n.status === 'cancelled'))
  const record = await client.call('work.show', { workId: work.id }) as { live?: unknown; events: { type: string }[] }
  assert.equal(record.live, undefined, 'nothing is live once the attempt reported')
  assert.deepEqual(record.events.map((e) => e.type), ['admitted', 'dispatched', 'observed', 'terminal'])
  assert.doesNotMatch(JSON.stringify(record), /turns|lastTool|stalled/, 'progress is an observation of the moment, not an event')
})

test('goal.brief prints the Goal, its budget left, its running, failed and held Works and its decisions; the same records give the same text', { timeout: 60_000 }, async () => {
  const { f, open, artifacts } = await started({ setup: (f) => f.capabilities.registerWorker({ ref: 'fake/failing', capabilities: ['fail-work'], async run() { return { status: 'failed', outputs: {}, reason: 'the tests failed' } } }) })
  const human = await open()
  const goal = (await human.call('goal.new', { aim: 'ship OC', scope: 'the Host', budget: { attempts: 10 } }) as { id: string }).id
  const other = (await human.call('goal.new', { aim: 'elsewhere', scope: 's', budget: {} }) as { id: string }).id
  const task = async (text: string) => (await artifacts.put({ ...TASK_KIND, content: { instructions: text }, classification: 'public', producer: { type: 'operator', ref: 'tan' } })).id
  const submit = async (params: object) => await human.call('work.submit', params) as { id: string }

  const failed = await submit({ capabilities: ['fail-work'], input: await task('two'), goal })
  await human.call('work.run', { workId: failed.id })
  const held = await submit({ workflow: heldWorkflow, uses: seUses, input: await task('three'), goal })
  await human.call('work.run', { workId: held.id })
  await submit({ capabilities: ['code-write'], input: await task('not ours'), goal: other })
  for (const id of [failed.id, held.id]) await terminal(human, id)
  // Started last: it holds the fake Account's one slot until released.
  f.hold('task')
  const running = await submit({ capabilities: ['code-write'], input: await task('one'), goal })
  await human.call('work.run', { workId: running.id })
  await f.arrived('task')
  const first = await human.call('decision.add', { goal, question: 'which direction?', options: ['x', 'y'], choice: 'x', reason: 'the synthesis' }) as { id: string }
  const second = await human.call('decision.add', { goal, question: 'merge now?', options: ['yes', 'no'], choice: 'no', reason: 'wait for checks' }) as { id: string }

  const orchestrated = await open(orchestrator(goal))
  const { text } = await orchestrated.call('goal.brief', { goal }) as { text: string }
  assert.match(text, /ship OC/)
  assert.match(text, /attempts: \d+ of 10 spent, \d+ left/)
  assert.match(text, new RegExp(`${running.id} running.*step task running`))
  assert.match(text, new RegExp(`${failed.id} failed: step task failed \\(the tests failed\\)\n`))
  assert.match(text, new RegExp(`${held.id} held.*awaits accept`))
  assert.doesNotMatch(text, /not ours|elsewhere/)
  assert.match(text, new RegExp(`which direction\\? -> x: the synthesis \\(${first.id}\\)`))
  assert.match(text, new RegExp(`merge now\\? -> no: wait for checks \\(${second.id}\\)`))
  assert.ok(text.indexOf(first.id) < text.indexOf(second.id), 'decisions oldest first')
  assert.match(text, new RegExp(`approval: ${held.id}`))
  assert.match(text, new RegExp(`failed: ${failed.id}`))
  assert.equal((await orchestrated.call('goal.brief', { goal }) as { text: string }).text, text, 'the same records give the same text')
  await assert.rejects(orchestrated.call('goal.brief', { goal: other }), (error: { code: number }) => error.code === NOT_ALLOWED)
  f.release('task')
  await terminal(human, running.id)
})

test('work.submit joins the Sub-workflows sent in uses: namespaced steps run and replay exactly; recursion and depth 4 are refused at admission', { timeout: 60_000 }, async () => {
  const { f, open } = await started()
  const client = await open()
  const head = (id: string) => `schema: system.workflow/v1\nid: ${id}\nversion: 1\nsteps:\n`
  const checks = `${head('checks')}  - id: checks\n    verify: { capability: code.required-checks, subject: $work.input, criteria: repo-checks-v1 }\n`
  const outer = `${head('outer')}  - id: implement
    capabilities: [code-write]
    inputs: { task: $work.input }
    outputs: [change]
  - id: checks
    dependsOn: [implement]
    uses: checks.yaml
    inputs: { input: $steps.implement.change }
  - id: accept
    dependsOn: [checks]
    accept: { requires: [checks.checks] }
`
  const work = await client.call('work.submit', { workflow: outer, uses: { 'checks.yaml': checks }, input: input(f) }) as { id: string; state: { steps: Record<string, unknown> } }
  assert.deepEqual(Object.keys(work.state.steps), ['implement', 'checks.checks', 'accept'])
  await client.call('work.run', { workId: work.id })
  assert.equal((await terminal(client, work.id)).status, 'succeeded')
  const shown = await client.call('work.show', { workId: work.id }) as { events: { type: string; stepId?: string; subject?: string }[]; state: { steps: Record<string, { outputs: Record<string, string> }> } }
  const verified = shown.events.find((e) => e.type === 'verified')!
  assert.deepEqual([verified.stepId, verified.subject], ['checks.checks', shown.state.steps.implement!.outputs.change])
  assert.equal((await client.call('work.replay', { workId: work.id }) as { matches: boolean }).matches, true)

  const using = (id: string, name: string) => `${head(id)}  - id: inner\n    uses: ${name}\n`
  await assert.rejects(client.call('work.submit', { workflow: using('a', 'b.yaml'), uses: { 'b.yaml': using('b', 'a.yaml'), 'a.yaml': using('a', 'b.yaml') }, input: input(f) }), /recursion: a -> b -> a/)
  const deep = { 'l1.yaml': using('l1', 'l2.yaml'), 'l2.yaml': using('l2', 'l3.yaml'), 'l3.yaml': using('l3', 'l4.yaml'), 'l4.yaml': checks }
  await assert.rejects(client.call('work.submit', { workflow: using('top', 'l1.yaml'), uses: deep, input: input(f) }), /deeper than 3/)
  await assert.rejects(client.call('work.submit', { workflow: outer, input: input(f) }), /checks\.yaml/)
})

test('software-engineering.yaml checks through code-checks.yaml: a failed check, retried on its own, passes on the same subject and the Work is accepted; the failed verdict is kept', { timeout: 60_000 }, async () => {
  const { f, open } = await started()
  const client = await open()
  const se = f.files('software-engineering.yaml')
  assert.match(se, /uses: code-checks\.yaml/)
  f.verdicts.push('fail')
  const work = await client.call('work.submit', { workflow: se, uses: { 'code-checks.yaml': f.files('code-checks.yaml') }, input: input(f) }) as { id: string; state: { steps: Record<string, unknown> } }
  assert.deepEqual(Object.keys(work.state.steps), ['implement', 'checks.checks', 'publish', 'accept'])
  await client.call('work.run', { workId: work.id })
  assert.equal((await terminal(client, work.id)).status, 'failed')
  type Shown = { events: { type: string; stepId?: string; subject?: string; verdict?: string; reset?: string[] }[]; state: { status: string; reason?: string; steps: Record<string, { verdict?: string; state: string; attempts: string[] }> } }
  const failed = await client.call('work.show', { workId: work.id }) as Shown
  assert.match(failed.state.reason!, /checks\.checks=fail/)
  const implemented = failed.state.steps.implement!.attempts

  // Choosing among runs of a check is the operator's: an agent is refused, and records a decision instead.
  await assert.rejects((await open(agent)).call('work.retry', { workId: work.id, step: 'checks.checks' }), /only a human verifies again/)
  // The environment is fixed; the same change is verified again, with the same pinned criteria.
  await assert.rejects(client.call('work.retry', { workId: work.id, step: 'checks.checks', worker: 'fake/claude' }), /verify step/)
  await client.call('work.retry', { workId: work.id, step: 'checks.checks', reason: 'the Host had Node 22 on its PATH' })
  assert.equal((await terminal(client, work.id)).status, 'succeeded')
  const done = await client.call('work.show', { workId: work.id }) as Shown
  const verdicts = done.events.filter((e) => e.type === 'verified')
  assert.deepEqual(verdicts.map((e) => [e.stepId, e.verdict]), [['checks.checks', 'fail'], ['checks.checks', 'pass']])
  assert.equal(verdicts[0]!.subject, verdicts[1]!.subject, 'the same subject')
  assert.deepEqual(done.state.steps.implement!.attempts, implemented, 'no new implement attempt')
  assert.deepEqual(done.events.find((e) => e.type === 'reopened')!.reset, ['checks.checks', 'publish', 'accept'])
  assert.equal(done.state.steps['checks.checks']!.verdict, 'pass')
  assert.equal((await client.call('work.replay', { workId: work.id }) as { matches: boolean }).matches, true)
})

test('work.submit without the content of the Sub-workflows: the Host reads them itself', { timeout: 60_000 }, async () => {
  const { f, open } = await started()
  const client = await open(agent)
  const work = await client.call('work.submit', { workflow: workflowFile('software-engineering.yaml'), input: input(f) }).catch((error: Error) => error)
  assert.ok(!(work instanceof Error), String(work))
  assert.deepEqual(Object.keys((work as { state: { steps: Record<string, unknown> } }).state.steps), ['implement', 'checks.checks', 'publish', 'accept'])
})
