/**
 * H4a: `system host` as a process. A real Host on a throwaway home, reached
 * with the client of @system/host; no model or GitHub credentials.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { PACKAGE_VERSION, VERSION, connect } from '../packages/host/src/index.ts'
import { systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-host-process', { SYSTEM_OPERATOR_ID: 'tester', SYSTEM_CALLER: 'human', SYSTEM_NO_SERVICE: '1' })
const socket = cli.socket
after(async () => {
  // Stop what a failed test left running; SIGKILL only if SIGTERM is not enough.
  await cli.stop()
  rmSync(cli.home, { recursive: true, force: true })
})

before(() => {
  const ran = cli.run(['init'])
  assert.equal(ran.status, 0, ran.stderr)
})

const human = { type: 'human', operatorId: 'tester' }

test('system host serves hello and status on host.sock, and logs its start', { timeout: 60_000 }, async () => {
  const host = await cli.start()
  const client = await connect(socket)
  try {
    assert.deepEqual(await client.call('host.hello', { version: VERSION, caller: human }), { version: VERSION, packageVersion: PACKAGE_VERSION })
    const status = await client.call('host.status') as { version: string; pid: number; works: number }
    assert.equal(status.version, VERSION)
    assert.equal(status.pid > 0, true)
    assert.equal(status.works, 0)
  } finally {
    client.close()
  }
  assert.match(host.stderr(), /^system host: started for \S+, listening on \S+host\.sock$/m)
  host.child.kill('SIGTERM')
  await host.exited
})

test('while a Host runs: a second Host fails at once, and the Work commands reach the running one', { timeout: 60_000 }, async () => {
  const host = await cli.start()
  const client = await connect(socket)
  client.close()
  const second = cli.run(['host'], { timeoutMs: 60_000 })
  assert.equal(second.status, 1)
  assert.match(second.stderr, /another Host already runs for /)
  // The refused one must not have touched the first one's socket.
  const again = await connect(socket)
  await again.call('host.hello', { version: VERSION, caller: human })
  again.close()

  // The Work commands go through the running Host, which answers them.
  for (const args of [['work', 'run', 'work:x'], ['work', 'retry', 'work:x'], ['work', 'cancel', 'work:x'], ['approve', 'work:x'], ['deny', 'work:x', '--reason', 'no']]) {
    const ran = cli.run(args, { timeoutMs: 60_000 })
    assert.equal(ran.status, 1, `${args.join(' ')}: ${ran.stderr}`)
    assert.equal(ran.stderr.trim(), 'system: no Work work:x', args.join(' '))
  }
  const submit = cli.run(['work', 'submit', '--capability', 'fake'], { timeoutMs: 60_000 })
  assert.equal(submit.status, 1)
  assert.match(submit.stderr, /^system: .*capability fake/)
  assert.equal(cli.run(['work', 'list']).status, 0)
  host.child.kill('SIGTERM')
  await host.exited
})

test('SIGTERM stops the Host with exit 0, releases the lock and the socket, and a new Host starts', async () => {
  const first = await cli.start()
  first.child.kill('SIGTERM')
  assert.deepEqual(await first.exited, { code: 0, signal: null })
  assert.match(first.stderr(), /^system host: stopped$/m)
  assert.equal(existsSync(socket), false)
  assert.match(cli.run(['work', 'list']).stderr, /the System Host is not running for /)

  const second = await cli.start()
  second.child.kill('SIGINT')
  assert.deepEqual(await second.exited, { code: 0, signal: null })
})

test('SIGTERM stops the Host within seconds while a client holds an idle connection open', { timeout: 30_000 }, async () => {
  const host = await cli.start()
  const client = await connect(socket)
  try {
    await client.call('host.hello', { version: VERSION, caller: human })
    const started = Date.now()
    host.child.kill('SIGTERM')
    assert.deepEqual(await host.exited, { code: 0, signal: null })
    assert.equal(Date.now() - started < 8_000, true, 'the Host did not wait for the client')
    assert.equal(existsSync(socket), false)
    await assert.rejects(client.call('host.status'), /closed the connection/)
  } finally {
    client.close()
  }
  const next = await cli.start()
  next.child.kill('SIGTERM')
  assert.equal((await next.exited).code, 0)
})

test('SIGTERM stops the Host within seconds while a client loops on work.events', { timeout: 30_000 }, async () => {
  const host = await cli.start()
  const client = await connect(socket)
  let running = true
  try {
    await client.call('host.hello', { version: VERSION, caller: human })
    // The loop ends when the Host closes the connection.
    const loop = (async () => { while (running) { try { await client.call('work.events', { workId: 'work:none' }) } catch { if (!running || await client.call('host.status').then(() => false, () => true)) return } } })()
    const started = Date.now()
    host.child.kill('SIGTERM')
    assert.deepEqual(await host.exited, { code: 0, signal: null })
    assert.equal(Date.now() - started < 8_000, true, 'the Host did not wait for the client')
    assert.equal(existsSync(socket), false)
    running = false
    await loop
  } finally {
    running = false
    client.close()
  }
})

test('a stale socket file left by a killed Host is replaced once the lock is taken', { timeout: 60_000 }, async () => {
  const first = await cli.start()
  const client = await connect(socket)
  await client.call('host.hello', { version: VERSION, caller: human })
  // The wrapper's child is the Host; killing it leaves the socket file behind.
  const { pid } = await client.call('host.status') as { pid: number }
  client.close()
  process.kill(pid, 'SIGKILL')
  await first.exited
  assert.equal(existsSync(socket), true)
  const second = await cli.start()
  const again = await connect(socket)
  await again.call('host.hello', { version: VERSION, caller: human })
  again.close()
  second.child.kill('SIGTERM')
  assert.equal((await second.exited).code, 0)
})


test('init on a home that is not ~/.dsh writes no unit and says to run `system host` in the foreground; --no-service and SYSTEM_NO_SERVICE=1 say nothing', { timeout: 60_000 }, () => {
  const foreground = cli.run(['init'], { env: { SYSTEM_NO_SERVICE: '0' } })
  assert.equal(foreground.status, 0, foreground.stderr)
  assert.match(foreground.stdout, /no service for \S+ \(only ~\/\.dsh gets one\): run `system host` in the foreground/)
  for (const ran of [cli.run(['init', '--no-service'], { env: { SYSTEM_NO_SERVICE: '0' } }), cli.run(['init'])]) {
    assert.equal(ran.status, 0, ran.stderr)
    assert.doesNotMatch(ran.stdout, /service/)
  }
})

test('the Host ignores the control files of the old mode and leaves them where they are; it makes no control directory', { timeout: 60_000 }, async () => {
  const control = join(cli.home, 'system', 'control')
  assert.equal(existsSync(control), false, 'nothing creates the old control directory')
  mkdirSync(control, { recursive: true })
  const left = { 'work_x.lock': `${process.pid} 1`, 'work_x.takeover': '', 'work_x.written': '{"host":"old","at":9999999999999}', 'work_x.cancel': '{}' }
  for (const [file, text] of Object.entries(left)) writeFileSync(join(control, file), text)
  const host = await cli.start()
  assert.equal(cli.run(['work', 'list']).status, 0)
  host.child.kill('SIGTERM')
  assert.equal((await host.exited).code, 0)
  for (const [file, text] of Object.entries(left)) assert.equal(readFileSync(join(control, file), 'utf8'), text, `${file} is neither read nor deleted`)
})

test('system host --supervise serves like a Host, and SIGTERM stops it with exit 0 and no new Host', { timeout: 60_000 }, async () => {
  const supervised = cli.runAsync(['host', '--supervise'])
  try {
    const client = await connect(socket, { retry: 30_000 })
    await client.call('host.hello', { version: VERSION, caller: human })
    client.close()
    supervised.child.kill('SIGTERM')
    const ran = await supervised.done
    assert.equal(ran.status, 0, ran.stderr)
    assert.doesNotMatch(ran.stderr, /restarting/)
    assert.equal(existsSync(socket), false)
  } finally {
    supervised.child.kill('SIGTERM')
    await supervised.done
  }
})
