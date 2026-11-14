import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Artifacts } from '@system/artifacts'
import { TASK_KIND, taskSchema } from '@system/work'
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
const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'workflows', 'brainstorm.yaml'), 'utf8')
const b64 = (text: string) => Buffer.from(text).toString('base64')

/** Services over in-memory stand-ins; what they were asked is recorded in `seen`. */
function services(f: Fixture, artifacts: Artifacts): Services & { seen: Record<string, unknown[]> } {
  const files = new Map<string, Uint8Array>()
  const seen: Record<string, unknown[]> = { credentials: [], logins: [] }
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
    workflowFile: (name) => { try { return workflowFile(name) } catch { return undefined } },
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
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema })
  const f = fixture()
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

  const work = await call('work.submit', { workflow, input: input(f), commandId: 'c-1', run: false }) as { id: string; state: { status: string } }
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

  const second = await call('work.submit', { capabilities: ['code-write'], input: input(f), run: false }) as { id: string }
  await call('work.run', { workId: second.id })
  assert.equal((await terminal(client, second.id)).status, 'succeeded')

  const pinned = await call('work.submit', { capabilities: ['code-write'], input: input(f), worker: 'fake/claude', run: false }) as { id: string; events: { type: string; worker?: string }[] }
  assert.equal(pinned.events[0]!.worker, 'fake/claude')
  await assert.rejects(call('work.submit', { capabilities: ['code-write'], input: input(f), worker: 'nobody/default' }), /no enabled Worker nobody\/default/)
  await assert.rejects(call('work.submit', { capabilities: ['code-write'], input: input(f), worker: 'fake/codex' }), /fake\/codex does not provide code-write/)

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
  // The status of a project: its Items from STATUS.md on dev; no Work names one here, so each is todo.
  const project = realpathSync(mkdtempSync(join(dir, 'project-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'dev')
  writeFileSync(join(project, 'STATUS.md'), 'Aim: a project\n- [x] p-1 First\n- [ ] p-2 Second\n- broken\n')
  git('add', '.')
  git('commit', '-qm', 'status')
  const lines = (await call('status', { repository: project })) as string[]
  assert.deepEqual(lines.slice(0, 2), ['[x] p-1 First - done', '[ ] p-2 Second - todo: nobody'])
  assert.match(lines[2]!, /^note: read dev \(/)
  assert.equal(lines[3], 'note: line 4: not an Item line (- [ ] <id> <title>)')
  assert.deepEqual(((await call('status', { repository: project, state: 'todo', item: 'p-2' })) as string[]).filter((l) => !l.startsWith('note: read ')), ['[ ] p-2 Second - todo: nobody', 'note: line 4: not an Item line (- [ ] <id> <title>)'])
  // A claim before a Work: status shows who and since when; an Item that is not in STATUS.md cannot be claimed.
  const claimed = await call('item.claim', { repository: project, item: 'p-2', commandId: 'c-1' }) as { who: string; at: string }
  assert.equal(claimed.who, 'tan')
  assert.equal(((await call('status', { repository: project, item: 'p-2' })) as string[])[0], `[ ] p-2 Second - doing: claimed by tan since ${claimed.at}`)
  await assert.rejects(call('item.claim', { repository: project, item: 'p-9' }), /p-9 has no line in STATUS\.md/)
  await assert.rejects(call('status', { repository: project, item: 'Bad' }), /-32602|invalid|item/i)
  await assert.rejects(call('task.new', { instructions: 'x', item: 'Bad' }), /-32602|invalid|item/i)
  // `force` and `item` are accepted by the rows; the refusal itself is the controller's (packages/work/tests/status.test.ts).
  await call('work.submit', { capabilities: ['code-write'], input: input(f), force: true, run: false })
  await call('task.new', { instructions: 'x', item: 'p-2' })
  const status = await call('host.status') as { works: number; recordBytes: number }
  assert.equal(status.works, 4)
  assert.ok(status.recordBytes > 0)

  assert.deepEqual([...called].sort(), Object.keys(tableOf(table)).sort(), 'a method of the table has no round trip in this test')
})

test('an agent connection is refused every method flagged agent: false, and only those', async () => {
  const { table, open } = await started()
  const client = await open(agent)
  const closed = Object.entries(tableOf(table)).filter(([, m]) => !m.agent).map(([name]) => name)
  assert.ok(closed.includes('approval.decide') && closed.includes('credentials.set') && closed.includes('workers.login') && closed.includes('workers.loginRemote') && closed.includes('workers.loginWait') && closed.includes('workers.recheck'))
  for (const [name, method] of Object.entries(tableOf(table))) {
    const outcome = await client.call(name, {}).then(() => undefined, (error: { code: number; message: string }) => error)
    if (method.agent) assert.notEqual(outcome?.code, NOT_ALLOWED, `${name} is open to agents`)
    else {
      assert.equal(outcome?.code, NOT_ALLOWED, `${name} must refuse an agent`)
      assert.match(outcome!.message, /not allowed for agents/)
    }
  }
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

test('work.submit rejects scalar Workflow contents with a clear path-or-contents message', async () => {
  const { open } = await started()
  const client = await open()
  await assert.rejects(client.call('work.submit', { workflow: 'hello', run: false }), /neither the path of a readable \.yaml file nor the contents of a Workflow/)
})

test('the same work.submit with the same commandId gives one Work, and another body is refused', async () => {
  const { f, open } = await started()
  const client = await open()
  const params = { workflow, input: input(f), commandId: 'lost-reply', run: false }
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
  const { id } = await client.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
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
  const { id } = await client.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
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
  const { id } = await first.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
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
  const { id } = await client.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
  await client.call('work.run', { workId: id })
  await f.arrived('idea-a')
  await assert.rejects(client.call('work.run', { workId: id }), /./)
  f.release('idea-a')
  assert.equal((await terminal(client, id)).status, 'succeeded')
})

test('the connection\'s caller is recorded on every Work event a call causes', async () => {
  const { f, open } = await started()
  const agentClient = await open(agent)
  const { id } = await agentClient.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
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

test('the same work.run with the same commandId while it runs answers at once and drives it once', async () => {
  const { f, open } = await started()
  f.hold('idea-a')
  const client = await open()
  const { id } = await client.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
  const first = await client.call('work.run', { workId: id, commandId: 'run-1' }) as { state: { status: string } }
  await f.arrived('idea-a')
  const again = await client.call('work.run', { workId: id, commandId: 'run-1' }) as { state: { status: string } }
  assert.equal(first.state.status, 'running')
  assert.equal(again.state.status, 'running')
  f.release('idea-a')
  assert.equal((await terminal(client, id)).status, 'succeeded')
  assert.equal(f.attempts.filter((s) => s === 'idea-a').length, 1)
})

test('a hello of type orchestrator is refused: callers are human or agent', async () => {
  const { path } = await started()
  const client = await connect(path)
  await assert.rejects(client.call('host.hello', { version: VERSION, caller: { type: 'orchestrator', operatorId: 'o1', goal: `sha256:${'a'.repeat(64)}` } }), (error: { code: number }) => error.code === -32602)
  client.close()
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
  for (const end = Date.now() + 120_000; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (ok()) return
  assert.fail(`timed out waiting for ${what}`)
}

const heldWorkflow = `${workflowFile('develop.yaml')}      approval: operator\n`
const seUses = { 'code-checks.yaml': workflowFile('code-checks.yaml') }

test('work.watch sends one work.changed when the Work finishes, and one when it is held', { timeout: 120_000 }, async () => {
  const { f, open } = await started()
  const { client, notices } = await listening(open)
  const done = await client.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
  assert.deepEqual(await client.call('work.watch', { workId: done.id }), { status: 'running', seq: 0 })
  await client.call('work.run', { workId: done.id })
  await settled('the notice', () => notices.length > 0)
  const last = (await events(client, done.id)).events.at(-1)!
  assert.deepEqual(notices, [{ workId: done.id, status: 'succeeded', seq: last.seq }])

  const held = await client.call('work.submit', { workflow: heldWorkflow, uses: seUses, input: input(f), run: false }) as { id: string }
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

test('work.unwatch stops the notices; a watch on another Work is not heard', { timeout: 120_000 }, async () => {
  const { f, open } = await started()
  const quiet = await listening(open)
  const loud = await listening(open)
  const work = await quiet.client.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
  const other = await quiet.client.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
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

test('a closed connection drops its watches', { timeout: 120_000 }, async () => {
  const { f, host, open } = await started()
  let live = 0
  const real = host.view.onChange.bind(host.view)
  host.view.onChange = (listener) => { live++; const stop = real(listener); return () => { live--; stop() } }
  const gone = await open()
  const work = await gone.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
  await gone.call('work.watch', { workId: work.id })
  assert.equal(live, 1)
  gone.close()
  await settled('the watches to drop', () => live === 0)
  const next = await open()
  await next.call('work.run', { workId: work.id })
  assert.equal((await terminal(next, work.id)).status, 'succeeded')
})

test('a client that missed the notice reads on from its cursor and loses nothing', { timeout: 120_000 }, async () => {
  const { f, open } = await started()
  const away = await listening(open)
  const work = await away.client.call('work.submit', { workflow, input: input(f), run: false }) as { id: string }
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

test('a running attempt shows its progress in work.show, and a quiet one sends a stall notice; the record keeps neither', { timeout: 120_000 }, async () => {
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
  const work = await client.call('work.submit', { capabilities: ['quiet-work'], run: false }) as { id: string }
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

test('work.submit joins the Sub-workflows sent in uses: namespaced steps run and replay exactly; recursion and depth 4 are refused at admission', { timeout: 120_000 }, async () => {
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
  const work = await client.call('work.submit', { workflow: outer, uses: { 'checks.yaml': checks }, input: input(f), run: false }) as { id: string; state: { steps: Record<string, unknown> } }
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

test('develop.yaml checks through code-checks.yaml: a failed check, retried on its own, passes on the same subject and the Work is accepted; the failed verdict is kept', { timeout: 120_000 }, async () => {
  const { f, open } = await started()
  const client = await open()
  const se = f.files('develop.yaml')
  assert.match(se, /uses: code-checks\.yaml/)
  // The Workflow's one automatic further attempt is checked too, and fails again.
  f.verdicts.push('fail', 'fail')
  const work = await client.call('work.submit', { workflow: se, uses: { 'code-checks.yaml': f.files('code-checks.yaml') }, input: input(f), run: false }) as { id: string; state: { steps: Record<string, unknown> } }
  assert.deepEqual(Object.keys(work.state.steps), ['implement', 'satisfied-check', 'checks.checks', 'publish', 'accept'])
  await client.call('work.run', { workId: work.id })
  assert.equal((await terminal(client, work.id)).status, 'failed')
  type Shown = { events: { type: string; stepId?: string; subject?: string; verdict?: string; reset?: string[] }[]; state: { status: string; reason?: string; steps: Record<string, { verdict?: string; state: string; attempts: string[] }> } }
  const failed = await client.call('work.show', { workId: work.id }) as Shown
  assert.match(failed.state.reason!, /checks\.checks=fail/)
  const implemented = failed.state.steps.implement!.attempts

  // Choosing among runs of a check is the operator's: an agent is refused, and tells the operator.
  await assert.rejects((await open(agent)).call('work.retry', { workId: work.id, step: 'checks.checks' }), /only a human verifies again/)
  // The environment is fixed; the same change is verified again, with the same pinned criteria.
  await assert.rejects(client.call('work.retry', { workId: work.id, step: 'checks.checks', worker: 'fake/claude' }), /verify step/)
  await client.call('work.retry', { workId: work.id, step: 'checks.checks', reason: 'the Host had Node 22 on its PATH' })
  assert.equal((await terminal(client, work.id)).status, 'succeeded')
  const done = await client.call('work.show', { workId: work.id }) as Shown
  const verdicts = done.events.filter((e) => e.type === 'verified')
  assert.deepEqual(verdicts.map((e) => [e.stepId, e.verdict]), [['checks.checks', 'fail'], ['checks.checks', 'fail'], ['checks.checks', 'pass']])
  assert.equal(verdicts[1]!.subject, verdicts[2]!.subject, 'the same subject')
  assert.notEqual(verdicts[0]!.subject, verdicts[1]!.subject, 'the automatic attempt made a new change')
  assert.equal(implemented.length, 2, 'the automatic further attempt, once')
  assert.deepEqual(done.state.steps.implement!.attempts, implemented, 'no new implement attempt')
  assert.deepEqual(done.events.findLast((e) => e.type === 'reopened')!.reset, ['checks.checks', 'publish', 'accept'])
  assert.equal(done.state.steps['checks.checks']!.verdict, 'pass')
  assert.equal((await client.call('work.replay', { workId: work.id }) as { matches: boolean }).matches, true)
})

test('work.submit without the content of the Sub-workflows: the Host reads them itself', { timeout: 120_000 }, async () => {
  const { f, open } = await started()
  const client = await open(agent)
  const work = await client.call('work.submit', { workflow: workflowFile('develop.yaml'), input: input(f) }).catch((error: Error) => error)
  assert.ok(!(work instanceof Error), String(work))
  assert.deepEqual(Object.keys((work as { state: { steps: Record<string, unknown> } }).state.steps), ['implement', 'satisfied-check', 'checks.checks', 'publish', 'accept'])
})
