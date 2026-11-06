/**
 * H4a: `system host` as a process. A real Host on a throwaway home, reached
 * with the client of @system/host; no model or GitHub credentials.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { VERSION, connect } from '../packages/host/src/index.ts'
import { repo, systemCli } from '../test-support/cli.ts'

// A socket path is limited to about 100 bytes, and tmpdir() may be longer.
const cli = systemCli('system-host-process', { SYSTEM_OPERATOR_ID: 'tester', SYSTEM_CALLER: 'human', SYSTEM_NO_SERVICE: '1' }, mkdtempSync('/tmp/sh-hp-'))
const socket = join(cli.home, 'system', 'host.sock')
const hosts: ChildProcess[] = []
after(() => {
  for (const host of hosts) host.kill('SIGKILL')
  rmSync(cli.home, { recursive: true, force: true })
})

before(() => {
  const ran = cli.run(['init'])
  assert.equal(ran.status, 0, ran.stderr)
})

interface Running {
  child: ChildProcess
  stderr: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function startHost(): Running {
  const child = spawn(process.execPath, [join(repo, 'bin', 'system'), 'host'], { env: cli.env, stdio: ['ignore', 'ignore', 'pipe'] })
  hosts.push(child)
  let stderr = ''
  child.stderr!.on('data', (d) => { stderr += d })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return { child, stderr: () => stderr, exited }
}

/** Connect once the Host answers, or fail with what it said if it exited first. */
async function reach(host: Running) {
  let gone = false
  void host.exited.then(() => { gone = true })
  for (let tries = 0; tries < 600; tries++) {
    if (gone) assert.fail(`the Host exited before answering: ${host.stderr()}`)
    try { return await connect(socket) } catch { await new Promise((resolve) => setTimeout(resolve, 100)) }
  }
  return assert.fail(`the Host never answered: ${host.stderr()}`)
}

const human = { type: 'human', operatorId: 'tester' }

test('system host serves hello and ping on host.sock, and logs its start', async () => {
  const host = startHost()
  const client = await reach(host)
  try {
    assert.deepEqual(await client.call('host.hello', { version: VERSION, caller: human }), { version: VERSION })
    const ping = await client.call('host.ping') as { version: string; pid: number; works: number }
    assert.equal(ping.version, VERSION)
    assert.equal(ping.pid > 0, true)
    assert.equal(ping.works, 0)
  } finally {
    client.close()
  }
  assert.match(host.stderr(), /^system host: started for \S+, listening on \S+host\.sock$/m)
  host.child.kill('SIGTERM')
  await host.exited
})

test('while a Host runs: a second Host fails at once, and old-path Work commands refuse', async () => {
  const host = startHost()
  const client = await reach(host)
  client.close()
  const second = cli.run(['host'], { timeoutMs: 60_000 })
  assert.equal(second.status, 1)
  assert.match(second.stderr, /another Host already runs for /)
  // The refused one must not have touched the first one's socket.
  const again = await connect(socket)
  await again.call('host.hello', { version: VERSION, caller: human })
  again.close()

  const message = `a Host is running for ${cli.home}; stop it first (systemctl --user stop system)`
  const commands = [
    ['work', 'submit', '--capability', 'fake'], ['work', 'run', 'work:x'], ['work', 'retry', 'work:x'],
    ['work', 'cancel', 'work:x'], ['approve', 'work:x'], ['deny', 'work:x', '--reason', 'no'],
  ]
  for (const args of commands) {
    const ran = cli.run(args, { timeoutMs: 60_000 })
    assert.equal(ran.status, 1, `${args.join(' ')}: ${ran.stderr}`)
    assert.equal(ran.stderr.trim(), `system: ${message}`, args.join(' '))
  }
  // Reading is not refused.
  assert.equal(cli.run(['work', 'list']).status, 0)
  host.child.kill('SIGTERM')
  await host.exited
})

test('SIGTERM stops the Host with exit 0, releases the lock and the socket, and a new Host starts', async () => {
  const first = startHost()
  ;(await reach(first)).close()
  first.child.kill('SIGTERM')
  assert.deepEqual(await first.exited, { code: 0, signal: null })
  assert.match(first.stderr(), /^system host: stopped$/m)
  assert.equal(existsSync(socket), false)
  assert.equal(cli.run(['work', 'list']).status, 0)

  const second = startHost()
  ;(await reach(second)).close()
  second.child.kill('SIGINT')
  assert.deepEqual(await second.exited, { code: 0, signal: null })
})

test('a stale socket file left by a killed Host is replaced once the lock is taken', async () => {
  const first = startHost()
  const client = await reach(first)
  await client.call('host.hello', { version: VERSION, caller: human })
  // The wrapper's child is the Host; killing it leaves the socket file behind.
  const { pid } = await client.call('host.ping') as { pid: number }
  client.close()
  process.kill(pid, 'SIGKILL')
  await first.exited
  assert.equal(existsSync(socket), true)
  const second = startHost()
  const again = await reach(second)
  await again.call('host.hello', { version: VERSION, caller: human })
  again.close()
  second.child.kill('SIGTERM')
  assert.equal((await second.exited).code, 0)
})


test('init on a home that is not ~/.dsh writes no unit and says to run `system host` in the foreground; --no-service and SYSTEM_NO_SERVICE=1 say nothing', () => {
  const foreground = cli.run(['init'], { env: { SYSTEM_NO_SERVICE: '0' } })
  assert.equal(foreground.status, 0, foreground.stderr)
  assert.match(foreground.stdout, /no service for \S+ \(only ~\/\.dsh gets one\): run `system host` in the foreground/)
  for (const ran of [cli.run(['init', '--no-service'], { env: { SYSTEM_NO_SERVICE: '0' } }), cli.run(['init'])]) {
    assert.equal(ran.status, 0, ran.stderr)
    assert.doesNotMatch(ran.stdout, /service/)
  }
})
