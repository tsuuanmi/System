import assert from 'node:assert/strict'
import { createConnection, type Socket } from 'node:net'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fixture } from '../../../test-support/fixture.ts'
import { MAX_FRAME, NotAnswering, NotRunning, PACKAGE_VERSION, VERSION, codeVersion, connect, serve, type Methods, type Served } from '../src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-host-api-'))
// A socket path is limited to about 100 bytes, and tmpdir() may be longer.
const sockets = mkdtempSync('/tmp/sh-')
after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(sockets, { recursive: true, force: true }) })
let count = 0
const fresh = () => { const path = join(dir, `n${count++}`); mkdirSync(path); return path }
const human = { type: 'human', operatorId: 'tan' }

async function served(methods?: Methods, version?: string, grace?: number): Promise<{ path: string; server: Served }> {
  const home = fresh()
  const host = await fixture().startHost(home)
  const path = join(sockets, `${count++}.sock`)
  const server = await serve(host, { path, methods, version, grace })
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

test('hello, then status reports the version, the pid and the memory of the records', async () => {
  const { path } = await served()
  const client = await connect(path)
  assert.deepEqual(await client.call('host.hello', { version: VERSION, caller: human }), { version: VERSION, packageVersion: PACKAGE_VERSION })
  assert.deepEqual(await client.call('host.status'), { version: VERSION, pid: process.pid, works: 0, recordBytes: 0 })
  client.close()
})

test('host.ping is gone: host.status is the one report', async () => {
  const { path } = await served()
  const client = await connect(path)
  await client.call('host.hello', { version: VERSION, caller: human })
  await assert.rejects(client.call('host.ping'), /unknown method host\.ping/)
  client.close()
})

test('a Host of another version refuses the hello and names the fix', async () => {
  const { path } = await served()
  const client = await connect(path)
  await assert.rejects(client.call('host.hello', { version: '9.9.9', caller: human }), /restart the Host: systemctl --user restart system/)
  await assert.rejects(client.call('host.status'), /host\.hello/)
  client.close()
})

/** A copy of two packages' built files, as `codeVersion` reads them. */
function build(): Record<string, string> {
  const copy = fresh()
  const dirs = { a: join(copy, 'a'), b: join(copy, 'b') }
  for (const dir of Object.values(dirs)) { mkdirSync(join(dir, 'sub'), { recursive: true }); writeFileSync(join(dir, 'index.js'), `export const ${dir.slice(-1)} = 1\n`); writeFileSync(join(dir, 'sub', 'x.js'), 'export const x = 1\n') }
  return dirs
}

test('the code version is a short hash of the built files: equal for equal builds, different when one file differs', () => {
  const one = build()
  const two = build()
  assert.match(codeVersion(one), /^[0-9a-f]{12}$/)
  assert.equal(codeVersion(one), codeVersion(one))
  // Same content in other directories is the same build.
  const copy = fresh()
  cpSync(one.a!, join(copy, 'a'), { recursive: true })
  cpSync(one.b!, join(copy, 'b'), { recursive: true })
  assert.equal(codeVersion({ a: join(copy, 'a'), b: join(copy, 'b') }), codeVersion(one))
  writeFileSync(join(two.b!, 'sub', 'x.js'), 'export const x = 2\n')
  assert.notEqual(codeVersion(two), codeVersion(one))
  // A file that is not JavaScript is not part of the build, and the order of the directories does not matter.
  writeFileSync(join(two.b!, 'sub', 'x.js'), 'export const x = 1\n')
  writeFileSync(join(two.a!, 'index.d.ts'), 'export {}\n')
  assert.equal(codeVersion({ b: two.b!, a: two.a! }), codeVersion(one))
  assert.match(VERSION, /^[0-9a-f]{12}$/)
})

test('the code version also covers the extra files that change behaviour, such as the bundle\'s Cordis patch', () => {
  const dirs = build()
  const file = join(fresh(), 'cordis.patch.yml')
  writeFileSync(file, '- id: agents\n')
  const before = codeVersion(dirs, [file])
  assert.notEqual(before, codeVersion(dirs), 'the file is part of the hash')
  assert.equal(codeVersion(dirs, [file]), before)
  writeFileSync(file, '- id: agents\n  disabled: true\n')
  assert.notEqual(codeVersion(dirs, [file]), before)
  assert.match(readFileSync(new URL('../../bundle/cordis.patch.yml', import.meta.url), 'utf8'), /\S/, 'the default file exists')
})

test('a Host started, then a built file changed, refuses a client built from the new code and names the fix', async () => {
  const dirs = build()
  const { path } = await served(undefined, codeVersion(dirs))
  writeFileSync(join(dirs.a!, 'index.js'), 'export const a = 2\n')
  const client = await connect(path)
  await assert.rejects(
    client.call('host.hello', { version: codeVersion(dirs), caller: human }),
    /systemctl --user restart system.*restart `system host`/,
  )
  client.close()
})

test('a call before hello is refused, and so is a malformed hello', async () => {
  const { path } = await served()
  const client = await connect(path)
  await assert.rejects(client.call('host.status'), /host\.hello first/)
  await assert.rejects(client.call('host.hello', { version: VERSION, caller: { type: 'robot', operatorId: 'x' } }), /caller/)
  await assert.rejects(client.call('host.status'), /host\.hello first/)
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
  await assert.rejects(connect(join(sockets, 'none.sock')), (error) => error instanceof NotRunning && /not running/.test(error.message))
})

test('a call times out against a server that never answers', async () => {
  const { createServer } = await import('node:net')
  const path = join(sockets, 'silent.sock')
  const silent = createServer(() => {})
  await new Promise<void>((resolve) => silent.listen(path, resolve))
  after(() => { silent.close() })
  const client = await connect(path, { timeout: 50 })
  await assert.rejects(client.call('host.status'), (error) => error instanceof NotAnswering && /not answering/.test(error.message))
  client.close()
})

test('close lets an admitted call finish, then drops an idle client without waiting for it', async () => {
  let release!: () => void
  const slow = new Promise<void>((resolve) => { release = resolve })
  const { path, server } = await served({ 'test.slow': { agent: true, handler: async () => { await slow; return 'done' } } })
  const busy = await connect(path)
  const idle = await connect(path)
  await busy.call('host.hello', { version: VERSION, caller: human })
  await idle.call('host.hello', { version: VERSION, caller: human })
  const answer = busy.call('test.slow')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const closing = server.close()
  setTimeout(release, 100)
  assert.equal(await answer, 'done')
  await closing
  await assert.rejects(idle.call('host.status'), NotRunning)
  await assert.rejects(connect(path), NotRunning)
  busy.close()
  idle.close()
})

test('close stops waiting for a call that outlasts the grace, and its client sees the connection close', async () => {
  const { path, server } = await served({ 'test.stuck': { agent: true, handler: () => new Promise(() => {}) } }, undefined, 100)
  const client = await connect(path)
  await client.call('host.hello', { version: VERSION, caller: human })
  const stuck = assert.rejects(client.call('test.stuck'), NotRunning)
  const started = Date.now()
  await server.close()
  assert.equal(Date.now() - started < 2_000, true)
  await stuck
  client.close()
})
