import assert from 'node:assert/strict'
import { createConnection, type Socket } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fixture } from '../../../test-support/fixture.ts'
import { MAX_FRAME, VERSION, connect, serve, type Methods, type Served } from '../src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-host-api-'))
// A socket path is limited to about 100 bytes, and tmpdir() may be longer.
const sockets = mkdtempSync('/tmp/sh-')
after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(sockets, { recursive: true, force: true }) })
let count = 0
const fresh = () => { const path = join(dir, `n${count++}`); mkdirSync(path); return path }
const human = { type: 'human', operatorId: 'tan' }

async function served(methods?: Methods): Promise<{ path: string; server: Served }> {
  const home = fresh()
  const host = await fixture().startHost(home)
  const path = join(sockets, `${count++}.sock`)
  const server = await serve(host, { path, methods })
  after(async () => { await server.close(); await host.close() })
  return { path, server }
}

/** A raw connection: send lines, read the next reply lines. */
function raw(path: string): { socket: Socket; lines: () => Promise<Record<string, any>>; closed: Promise<void> } {
  const socket = createConnection(path)
  const queue: string[] = []
  let wake: (() => void) | undefined
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) { queue.push(buffer.slice(0, at)); buffer = buffer.slice(at + 1) }
    wake?.()
  })
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  socket.on('error', () => {})
  after(() => socket.destroy())
  return {
    socket,
    closed,
    async lines() {
      while (!queue.length) await new Promise<void>((resolve) => { wake = resolve })
      return JSON.parse(queue.shift()!)
    },
  }
}

test('hello, then ping reports the version, the pid and the memory of the records', async () => {
  const { path } = await served()
  const client = await connect(path)
  assert.deepEqual(await client.call('host.hello', { version: VERSION, caller: human }), { version: VERSION })
  assert.deepEqual(await client.call('host.ping'), { version: VERSION, pid: process.pid, works: 0, recordBytes: 0 })
  client.close()
})

test('a Host of another version refuses the hello and names the fix', async () => {
  const { path } = await served()
  const client = await connect(path)
  await assert.rejects(client.call('host.hello', { version: '9.9.9', caller: human }), /restart the Host: systemctl --user restart system/)
  await assert.rejects(client.call('host.ping'), /host\.hello/)
  client.close()
})

test('a call before hello is refused, and so is a malformed hello', async () => {
  const { path } = await served()
  const client = await connect(path)
  await assert.rejects(client.call('host.ping'), /host\.hello first/)
  await assert.rejects(client.call('host.hello', { version: VERSION, caller: { type: 'robot', operatorId: 'x' } }), /caller/)
  await assert.rejects(client.call('host.ping'), /host\.hello first/)
  client.close()
})

test('an oversize frame gets -32600 and the connection is closed', async () => {
  const { path } = await served()
  const c = raw(path)
  c.socket.write(`{"jsonrpc":"2.0","id":1,"method":"host.hello","params":"${'x'.repeat(MAX_FRAME)}"}\n`)
  const reply = await c.lines()
  assert.equal(reply.error.code, -32600)
  assert.equal(reply.id, null)
  await c.closed
})

test('malformed JSON gets -32700 and the connection stays open', async () => {
  const { path } = await served()
  const c = raw(path)
  c.socket.write('{nope\n')
  assert.equal((await c.lines()).error.code, -32700)
  c.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'host.hello', params: { version: VERSION, caller: human } })}\n`)
  assert.equal((await c.lines()).id, 7)
})

test('an unknown method gets -32601', async () => {
  const { path } = await served()
  const client = await connect(path)
  await client.call('host.hello', { version: VERSION, caller: human })
  await assert.rejects(client.call('nope'), (e: any) => e.code === -32601)
  client.close()
})

test('two calls are answered out of order and matched by id', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { path } = await served({
    slow: { agent: true, handler: async () => { await gate; return 'slow' } },
    fast: { agent: true, handler: async () => { release(); return 'fast' } },
  })
  const client = await connect(path)
  await client.call('host.hello', { version: VERSION, caller: human })
  const order: string[] = []
  const slow = client.call('slow').then((r) => { order.push(r as string) })
  const fast = client.call('fast').then((r) => { order.push(r as string) })
  await Promise.all([slow, fast])
  assert.deepEqual(order, ['fast', 'slow'])
  client.close()
})

test('the caller of the connection reaches the handler', async () => {
  const { path } = await served({ who: { agent: true, handler: async (_host, _params, caller) => caller } })
  const client = await connect(path)
  await client.call('host.hello', { version: VERSION, caller: { type: 'agent', operatorId: 'a1' } })
  assert.deepEqual(await client.call('who'), { type: 'agent', operatorId: 'a1' })
  client.close()
})

test('with no socket the client says the Host is not running', async () => {
  await assert.rejects(connect(join(sockets, 'none.sock')), /not running/)
})

test('a call times out against a server that never answers', async () => {
  const { createServer } = await import('node:net')
  const path = join(sockets, 'silent.sock')
  const silent = createServer(() => {})
  await new Promise<void>((resolve) => silent.listen(path, resolve))
  after(() => { silent.close() })
  const client = await connect(path, { timeout: 50 })
  await assert.rejects(client.call('host.ping'), /not answering/)
  client.close()
})
