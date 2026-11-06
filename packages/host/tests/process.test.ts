import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fixture } from '../../../test-support/fixture.ts'
import { VERSION, connect } from '../src/index.ts'
import type { Services } from '../src/operations.ts'
import { serveHost, socketPath } from '../src/process.ts'

// A socket path is limited to about 100 bytes, and tmpdir() may be longer.
const base = mkdtempSync('/tmp/sh-')
after(() => rmSync(base, { recursive: true, force: true }))
let count = 0
const fresh = () => { const path = join(base, `h${count++}`); mkdirSync(path); return path }
const human = { type: 'human', operatorId: 'tan' }

async function started(home: string) {
  const lines: string[] = []
  const host = await fixture().startHost(home)
  const serving = await serveHost({ host, home, services: {} as Services, log: (line) => lines.push(line) })
  return { host, serving, lines }
}

test('the Host answers on $DSH_HOME/system/host.sock, logs a start and a stop, and frees the socket and the home', { timeout: 60_000 }, async () => {
  const home = fresh()
  const { serving, lines } = await started(home)
  const client = await connect(socketPath(home))
  await client.call('host.hello', { version: VERSION, caller: human })
  assert.equal(((await client.call('host.ping')) as { works: number }).works, 0)
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /^started for .*, listening on .*host\.sock$/)
  await serving.stop()
  await serving.stop()
  assert.deepEqual(lines.slice(1), ['stopped'])
  assert.equal(existsSync(socketPath(home)), false)
  await assert.rejects(connect(socketPath(home)), /not running/)
  // The home is free: another Host starts.
  await (await started(home)).serving.stop()
})

test('a stale socket file is removed once the lock is held', { timeout: 60_000 }, async () => {
  const home = fresh()
  mkdirSync(join(home, 'system'))
  // A killed process leaves its file behind but no listener.
  const dead = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('up'))", socketPath(home)], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise((up) => dead.stdout.once('data', up))
  dead.kill('SIGKILL')
  await new Promise((gone) => dead.once('exit', gone))
  assert.equal(existsSync(socketPath(home)), true)
  await assert.rejects(connect(socketPath(home)), /not running/)
  const { serving } = await started(home)
  const client = await connect(socketPath(home))
  await client.call('host.hello', { version: VERSION, caller: human })
  client.close()
  await serving.stop()
})

test('something that is not a socket at the path is not removed', { timeout: 60_000 }, async () => {
  const home = fresh()
  mkdirSync(join(home, 'system'))
  writeFileSync(socketPath(home), 'mine')
  const host = await fixture().startHost(home)
  await assert.rejects(serveHost({ host, home, services: {} as Services, log: () => {} }), /EADDRINUSE/)
  assert.equal(existsSync(socketPath(home)), true)
  await host.close()
})

test('a home whose socket path is too long for a Unix socket is refused with the fix', { timeout: 60_000 }, async () => {
  const home = join(fresh(), 'x'.repeat(100))
  mkdirSync(home)
  const host = await fixture().startHost(home)
  await assert.rejects(serveHost({ host, home, services: {} as Services, log: () => {} }), /too long for a Unix socket.*shorter DSH_HOME/)
  await host.close()
})
