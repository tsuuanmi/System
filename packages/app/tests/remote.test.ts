import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NotRunning, RpcError, UPGRADING, type Client } from '../../host/lib/index.js'
import { remoteHost } from '../src/remote.ts'

const client = (call: (method: string, params?: unknown) => Promise<unknown>): Client => ({ call: (method, params) => call(method, params), onNotice: () => {}, close: () => {} })

test('following a Work reconnects once when the Host closes the connection for an upgrade', { timeout: 20_000 }, async () => {
  let opened = 0
  const open = async (): Promise<Client> => {
    opened++
    return opened === 1
      ? client(async () => { throw new NotRunning('the Host closed the connection (it stopped or was restarted)') })
      : client(async (method) => (method === 'work.events' ? { events: [{ seq: 3 }], status: 'succeeded' } : { id: 'work:x', state: { status: 'succeeded' } }))
  }
  const followed = await remoteHost({ open, err: () => {} }).work().wait('work:x')
  assert.equal(opened, 2)
  assert.equal((followed as { id: string }).id, 'work:x')
})

test('a Host that is still away after RECONNECT_MS is the error', { timeout: 20_000 }, async () => {
  const open = async (): Promise<Client> => client(async () => { throw new NotRunning('the Host is not running') })
  await assert.rejects(remoteHost({ open, err: () => {}, reconnectMs: 1500 }).work().wait('work:x'), /not running/)
})

test('a Workflow file is sent with every Workflow file it uses, read from beside it, nested ones too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-uses-'))
  try {
    const head = (id: string) => `schema: system.workflow/v1\nid: ${id}\nversion: 1\nsteps:\n`
    writeFileSync(join(dir, 'outer.yaml'), `${head('outer')}  - id: a\n    uses: middle.yaml\n  - id: b\n    uses: middle.yaml\n`)
    writeFileSync(join(dir, 'middle.yaml'), `${head('middle')}  - id: c\n    uses: inner.yaml\n`)
    writeFileSync(join(dir, 'inner.yaml'), `${head('inner')}  - id: d\n    capabilities: [x]\n    outputs: [y]\n`)
    writeFileSync(join(dir, 'self.yaml'), `${head('self')}  - id: a\n    uses: self.yaml\n`)
    const sent: unknown[] = []
    const open = async (): Promise<Client> => client(async (method, params) => { sent.push(params); return { id: 'work:x' } })
    await remoteHost({ open, err: () => {} }).work().admitFile(join(dir, 'outer.yaml'), undefined)
    assert.deepEqual(Object.keys((sent[0] as { uses: Record<string, string> }).uses).sort(), ['inner.yaml', 'middle.yaml'])
    // Recursion is the Host's to refuse; the client reads each file once.
    await remoteHost({ open, err: () => {} }).work().admitFile(join(dir, 'self.yaml'), undefined)
    assert.deepEqual(Object.keys((sent[1] as { uses: Record<string, string> }).uses), ['self.yaml'])
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
  const host = remoteHost({ open, err: () => {} })
  assert.deepEqual(await host.work().list(), [{ id: 'work:x', status: 'running', specId: 's' }])
  assert.deepEqual(opened, [undefined, true])
  await assert.rejects(host.work().cancel('work:x', 'r'), /upgrading/)
})
