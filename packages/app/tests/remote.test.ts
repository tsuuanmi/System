import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NotAnswering, NotRunning, RpcError, UPGRADING, type Client } from '../../host/lib/index.js'
import { hostClient, readWorkflowFile } from '../src/remote.ts'
import { operations, type Services } from '../../host/src/operations.ts'
import { tableOf } from '../../host/src/index.ts'

const client = (call: (method: string, params?: unknown) => Promise<unknown>): Client => ({ call: (method, params) => call(method, params), onNotice: () => {}, close: () => {} })

test('following a Work reconnects once when the Host closes the connection for an upgrade', { timeout: 120_000 }, async () => {
  let opened = 0
  const open = async (): Promise<Client> => {
    opened++
    return opened === 1
      ? client(async () => { throw new NotRunning('the Host closed the connection (it stopped or was restarted)') })
      : client(async (method) => (method === 'work.events' ? { events: [{ seq: 3 }], status: 'succeeded' } : { id: 'work:x', state: { status: 'succeeded' } }))
  }
  const followed = await hostClient({ open, err: () => {} }).wait('work:x')
  assert.equal(opened, 2)
  assert.equal((followed as { id: string }).id, 'work:x')
})

test('a Host that is still away after RECONNECT_MS is the error', { timeout: 120_000 }, async () => {
  const open = async (): Promise<Client> => client(async () => { throw new NotRunning('the Host is not running') })
  await assert.rejects(hostClient({ open, err: () => {}, reconnectMs: 1500 }).wait('work:x'), /not running/)
})

test('a Workflow file is sent with every Workflow file it uses, read from beside it, nested ones too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-uses-'))
  try {
    const head = (id: string) => `schema: system.workflow/v1\nid: ${id}\nversion: 1\nsteps:\n`
    writeFileSync(join(dir, 'outer.yaml'), `${head('outer')}  - id: a\n    uses: middle.yaml\n  - id: b\n    uses: middle.yaml\n`)
    writeFileSync(join(dir, 'middle.yaml'), `${head('middle')}  - id: c\n    uses: inner.yaml\n`)
    writeFileSync(join(dir, 'inner.yaml'), `${head('inner')}  - id: d\n    capabilities: [x]\n    outputs: [y]\n`)
    writeFileSync(join(dir, 'self.yaml'), `${head('self')}  - id: a\n    uses: self.yaml\n`)
    assert.deepEqual(Object.keys(readWorkflowFile(join(dir, 'outer.yaml')).uses).sort(), ['inner.yaml', 'middle.yaml'])
    // Recursion is the Host's to refuse; each file is read once.
    assert.deepEqual(Object.keys(readWorkflowFile(join(dir, 'self.yaml')).uses), ['self.yaml'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a read during a Host\'s upgrade wait goes over a read-only connection; a change still says to retry', async () => {
  const opened: (boolean | undefined)[] = []
  const open = async (_caller: unknown, options?: { readOnly?: boolean }): Promise<Client> => {
    opened.push(options?.readOnly)
    if (!options?.readOnly) throw new RpcError(UPGRADING, 'the Host runs code a and is upgrading to the code on disk, b: retry in a moment')
    return client(async (method) => (method === 'work.list' ? [{ id: 'work:x', status: 'running', specId: 's' }] : (() => { throw new RpcError(UPGRADING, `${method}: this Host is upgrading to b; retry after`) })()))
  }
  const host = hostClient({ open, err: () => {} })
  assert.deepEqual(await host.call('work.list', {}), [{ id: 'work:x', status: 'running', specId: 's' }])
  assert.deepEqual(opened, [undefined, true])
  await assert.rejects(host.call('work.cancel', { workId: 'work:x', reason: 'r' }), /upgrading/)
})

test('a write during a Host\'s upgrade wait is not sent over a read-only connection, and carries a commandId', async () => {
  const opened: (boolean | undefined)[] = []
  const sent: { method: string; params: any }[] = []
  const open = async (_caller: unknown, options?: { readOnly?: boolean }): Promise<Client> => {
    opened.push(options?.readOnly)
    if (!options?.readOnly) throw new RpcError(UPGRADING, 'the Host runs code a and is upgrading to the code on disk, b: retry in a moment')
    return client(async (method, params) => { sent.push({ method, params }); return { intent: 'sha256:i' } })
  }
  await assert.rejects(hostClient({ open, err: () => {} }).call('intent.new', { title: 'T', body: 'B' }), /upgrading/)
  assert.ok(!opened.includes(true), 'a write was offered a read-only session')
  assert.deepEqual(sent, [])
})

test('a write carries a fresh commandId, and a repeat after NotAnswering carries the same one', async () => {
  const ids: string[] = []
  let calls = 0
  const open = async (): Promise<Client> => client(async (method, params) => {
    ids.push((params as { commandId?: string }).commandId ?? '')
    if (calls++ === 0) throw new NotAnswering(`the Host is not answering ${method}`)
    return { intent: 'sha256:i' }
  })
  await hostClient({ open, err: () => {} }).call('intent.new', { title: 'T', body: 'B' })
  assert.equal(ids.length, 2)
  assert.ok(ids[0])
  assert.equal(ids[0], ids[1])
})

// A Host that, like the real one (ADR-0016), serves an `operator` operation only on the operator socket.
const operatorMethods = Object.entries(tableOf(operations({} as Services))).filter(([, row]) => row.authority === 'operator').map(([name]) => name)

function strictHost(answers: Record<string, (params: any) => unknown>) {
  const sent: { method: string; operator: boolean; params: any }[] = []
  const open = async (_caller: unknown, options?: { operator?: boolean }): Promise<Client> => {
    const operator = options?.operator === true
    return client(async (method, params) => {
      sent.push({ method, operator, params })
      if (operatorMethods.includes(method) && !operator) throw new RpcError(-32001, `${method}: operator authority is served only on the operator socket`)
      return answers[method]?.(params) ?? null
    })
  }
  return { open, sent }
}

test('login --remote waits and cancels over the operator socket, which is the only one that serves workers.loginWait', async () => {
  let release!: (report: unknown) => void
  const waiting = new Promise((resolve) => { release = resolve })
  const host = strictHost({
    'workers.loginRemote': () => ({ url: 'http://127.0.0.1:1/t/', port: 1, ssh: 'ssh -L 1:127.0.0.1:1 u@h', expiresAt: 0 }),
    'workers.loginWait': (params) => {
      if (params.cancel) { release({ signedIn: false, detail: 'cancelled' }); return { signedIn: false, detail: 'cancelled' } }
      return waiting
    },
  })
  let shown = 0
  const done = hostClient({ open: host.open, err: () => {} }).loginRemote('web/chatgpt/default', () => { shown++ })
  for (let i = 0; i < 100 && !host.sent.some((s) => s.method === 'workers.loginWait'); i++) await new Promise((r) => setTimeout(r, 10))
  process.emit('SIGINT')
  assert.deepEqual(await done, { signedIn: false, detail: 'cancelled' })
  assert.equal(shown, 1)
  const waits = host.sent.filter((s) => s.method === 'workers.loginWait')
  assert.equal(waits.length, 2)
  assert.ok(waits.every((s) => s.operator), 'workers.loginWait was sent on the ordinary socket')
  assert.equal(waits.filter((s) => s.params.cancel).length, 1)
})

test('every operator operation the client sends goes over the operator socket', async () => {
  const host = strictHost({})
  const hc = hostClient({ open: host.open, err: () => {} })
  for (const method of operatorMethods) {
    host.sent.length = 0
    // Some answer shapes are not what the callers expect; only the socket matters.
    await (hc.call as (m: string, p: object) => Promise<unknown>)(method, {}).catch(() => {})
    assert.ok(host.sent.length > 0 && host.sent.every((s) => s.operator), `${method} was sent on the ordinary socket`)
  }
  // The flows that call an operator operation themselves.
  host.sent.length = 0
  await hc.decide({ workId: 'work:x', step: 's', decision: 'approve' } as never, 'op').catch(() => {})
  assert.ok(host.sent.filter((s) => operatorMethods.includes(s.method)).every((s) => s.operator))
})

test('remote.ts names no operator operation on a client of the ordinary connection', () => {
  const source = readFileSync(new URL('../src/remote.ts', import.meta.url), 'utf8')
  for (const method of operatorMethods) assert.doesNotMatch(source, new RegExp(`client\\.call\\(\\s*'${method.replace('.', '\\.')}'`), `${method} is called on a client; use onOperatorSocket`)
})
