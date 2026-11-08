import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { supervise } from '../../../bin/service.mjs'
import { fixture, type Fixture } from '../../../test-support/fixture.ts'
import { REFUSED, UPGRADING, connect, connectHello, type Client } from '../src/index.ts'
import type { Services } from '../src/operations.ts'
import { UPGRADE_EXIT, serveHost, socketPath, type ServingHost } from '../src/process.ts'

// A socket path is limited to about 100 bytes, and tmpdir() may be longer.
const base = mkdtempSync('/tmp/sh-')
const running: ServingHost[] = []
after(async () => {
  for (const serving of running) await serving.stop()
  rmSync(base, { recursive: true, force: true })
})
let count = 0
const fresh = () => { const path = join(base, `u${count++}`); mkdirSync(path); return path }
const human = { type: 'human', operatorId: 'tan' } as const
const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'workflows', 'brainstorm.yaml'), 'utf8')
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 500 && !condition(); tries++) await wait(10)
  assert.equal(condition(), true, what)
}

/** One Host incarnation over the fixture: what `system host` does with `codeVersion` standing for the files on disk. */
async function incarnate(f: Fixture, home: string, version: string, codeVersion: () => string, log: (line: string) => void, upgradePoll = 5, building?: () => boolean): Promise<ServingHost> {
  const host = await f.startHost(home)
  const serving = await serveHost({ host, home, services: { capabilities: f.capabilities } as unknown as Services, log, version, codeVersion, upgradePoll, building })
  running.push(serving)
  return serving
}

const submitAndRun = async (client: Client, f: Fixture, commandId: string): Promise<string> => {
  const work = await client.call('work.submit', { workflow, input: f.admission('brainstorm.yaml').input, commandId }) as { id: string }
  await client.call('work.run', { workId: work.id })
  return work.id
}

test('on new code a supervised Host starts nothing new, finishes its attempt, exits 75, and the next Host serves the new version and runs what was queued', { timeout: 30_000 }, async () => {
  const f = fixture()
  const home = fresh()
  const logs: string[] = []
  let disk = 'code-1'
  let starts = 0
  const exits: number[] = []
  const supervised = supervise({
    run: async () => {
      starts++
      const serving = await incarnate(f, home, disk, () => disk, (line) => logs.push(line))
      const status = await serving.exited
      exits.push(status)
      return status
    },
    stopped: () => false,
    log: (line) => logs.push(line),
  })
  await until(() => existsSync(socketPath(home)), 'the first Host listens')

  const old = await connectHello(socketPath(home), { version: 'code-1', caller: human })
  f.hold('idea-a')
  const first = await submitAndRun(old, f, 'one')
  await f.arrived('idea-a')
  await until(() => f.attempts.includes('idea-b'), 'the second proposal runs beside the first')

  disk = 'code-2'
  await until(() => logs.some((line) => /upgrading/.test(line)), 'the Host notices the new code')
  // A Work arrives during the upgrade: it is accepted, and nothing of it starts.
  const second = await submitAndRun(old, f, 'two')
  await wait(50)
  assert.deepEqual(f.attempts, ['idea-a', 'idea-b'], 'no new attempt while upgrading')
  assert.equal(starts, 1)

  // A client built from the new code calls during the swap: refused while the old Host drains, absent between the Hosts, served by the new one.
  const swapped = connectHello(socketPath(home), { version: 'code-2', caller: human, retry: 5_000 }).then(async (client) => {
    try { return await client.call('host.status') as { version: string } } finally { client.close() }
  })
  f.release('idea-a')
  assert.equal((await swapped).version, 'code-2')
  assert.deepEqual(exits, [UPGRADE_EXIT])
  assert.equal(starts, 2)
  assert.match(logs.join('\n'), /upgrading: .*code-1.*code-2/)
  assert.match(logs.join('\n'), /exiting 75/)

  // The new Host finishes the Work the old one held, and the one queued during the upgrade.
  const after2 = await connectHello(socketPath(home), { version: 'code-2', caller: human })
  try {
    for (const id of [first, second]) {
      await until(() => f.controller.get(id)?.state.status === 'succeeded', `${id} runs after the upgrade`)
    }
  } finally {
    after2.close()
  }
  assert.match(logs.join('\n'), /continuing 2 Works held for the upgrade/)

  await running.at(-1)!.stop()
  assert.equal(await supervised, 0, 'a stop is not restarted')
  assert.equal(starts, 2)
  old.close()
})

test('a client built from the new code upgrades an idle Host at once, and is told to retry', { timeout: 30_000 }, async () => {
  const f = fixture()
  const home = fresh()
  const logs: string[] = []
  // The timer never fires: only the client's hello makes the Host look.
  const serving = await incarnate(f, home, 'code-1', () => 'code-2', (line) => logs.push(line), 3_600_000)
  const client = await connect(socketPath(home))
  await assert.rejects(client.call('host.hello', { version: 'code-2', caller: human }), (error: { code: number; message: string }) => error.code === UPGRADING && /upgrading/.test(error.message))
  client.close()
  assert.equal(await serving.exited, UPGRADE_EXIT)
  assert.equal(existsSync(socketPath(home)), false)
  // A client of another version than the disk's gets the plain refusal.
  const next = await incarnate(f, home, 'code-2', () => 'code-2', () => {}, 3_600_000)
  const other = await connect(socketPath(home))
  await assert.rejects(other.call('host.hello', { version: 'code-9', caller: human }), /restart the Host/)
  other.close()
  await next.stop()
})

test('a change seen once is not enough: a build still writing the files does not restart the Host', { timeout: 30_000 }, async () => {
  const f = fixture()
  const logs: string[] = []
  let reads = 0
  const serving = await incarnate(f, fresh(), 'code-1', () => (++reads === 3 ? 'half-built' : 'code-1'), (line) => logs.push(line))
  await until(() => reads > 10, 'the Host looked again')
  assert.doesNotMatch(logs.join('\n'), /upgrading/)
  await serving.stop()
})

test('a stop while the Host drains exits 0 and leaves nothing to continue', { timeout: 30_000 }, async () => {
  const f = fixture()
  const home = fresh()
  const logs: string[] = []
  let disk = 'code-1'
  const serving = await incarnate(f, home, 'code-1', () => disk, (line) => logs.push(line))
  const client = await connectHello(socketPath(home), { version: 'code-1', caller: human })
  f.hold('idea-a')
  await submitAndRun(client, f, 'one')
  await f.arrived('idea-a')
  disk = 'code-2'
  await until(() => logs.some((line) => /upgrading/.test(line)), 'draining')
  await serving.stop()
  assert.equal(await serving.exited, 0)
  assert.equal(existsSync(join(home, 'system', 'upgrade.json')), false)
  f.release('idea-a')
  client.close()
})

test('a connection retries while the Host is away, and says not running once the time is up', { timeout: 30_000 }, async () => {
  const f = fixture()
  const home = fresh()
  const late = wait(150).then(() => incarnate(f, home, 'code-1', () => 'code-1', () => {}))
  const client = await connectHello(socketPath(home), { version: 'code-1', caller: human, retry: 5_000 })
  assert.equal(((await client.call('host.status')) as { version: string }).version, 'code-1')
  client.close()
  await late
  await running.at(-1)!.stop()

  const started = Date.now()
  await assert.rejects(connectHello(socketPath(home), { version: 'code-1', caller: human, retry: 200 }), /the Host is not running/)
  assert.equal(Date.now() - started >= 200, true)
  await assert.rejects(connectHello(socketPath(home), { version: 'code-1', caller: human }), /the Host is not running/)
})

test('while a build runs, the Host does not upgrade: not from its own looks, nor for a client built from the half-built tree', { timeout: 30_000 }, async () => {
  const f = fixture()
  const home = fresh()
  const logs: string[] = []
  let asks = 0
  let building = true
  const serving = await incarnate(f, home, 'code-1', () => 'code-2', (line) => logs.push(line), 5, () => { asks++; return building })
  await until(() => asks > 10 || logs.length > 1, 'the Host looked again')
  const refused = await connectHello(socketPath(home), { version: 'code-2', caller: human }).then(() => 'answered', (error: { code: number }) => error.code)
  assert.notEqual(refused, UPGRADING, 'a client of the half-built code is refused, not upgraded to')
  assert.doesNotMatch(logs.join('\n'), /upgrading/)
  // The build ends: the same code, seen stable, is upgraded to.
  building = false
  await until(() => /upgrading/.test(logs.join('\n')), 'the upgrade once the build ended')
  assert.equal(await serving.exited, UPGRADE_EXIT)
})

test('while a Host waits on a long attempt to upgrade, a client of any version reads, and is told to retry anything else', { timeout: 30_000 }, async () => {
  const f = fixture()
  const home = fresh()
  const logs: string[] = []
  let disk = 'code-1'
  const serving = await incarnate(f, home, 'code-1', () => disk, (line) => logs.push(line))
  const old = await connectHello(socketPath(home), { version: 'code-1', caller: human })
  f.hold('idea-a')
  const work = await submitAndRun(old, f, 'long')
  await f.arrived('idea-a')
  // Not upgrading: a read-only hello does not get round the version check.
  await assert.rejects(connectHello(socketPath(home), { version: 'code-9', caller: human, readOnly: true }), (error: { code: number }) => error.code === REFUSED)
  disk = 'code-2'
  await until(() => logs.some((line) => /upgrading/.test(line)), 'the Host notices the new code')

  // A full hello of the new code is still refused while the Host drains.
  await assert.rejects(connectHello(socketPath(home), { version: 'code-2', caller: human }), (error: { code: number }) => error.code === UPGRADING)
  const reader = await connectHello(socketPath(home), { version: 'code-2', caller: human, readOnly: true })
  assert.equal((await reader.call('work.show', { workId: work }) as { id: string }).id, work)
  assert.ok(Array.isArray(await reader.call('work.list')))
  await assert.rejects(reader.call('work.cancel', { workId: work }), (error: { code: number; message: string }) => error.code === UPGRADING && /upgrading to code-2; retry after/.test(error.message))
  // Any version reads while the Host waits.
  const other = await connectHello(socketPath(home), { version: 'code-9', caller: human, readOnly: true })
  assert.ok(Array.isArray(await other.call('work.list')))
  other.close()
  reader.close()
  old.close()
  f.release('idea-a')
  assert.equal(await serving.exited, UPGRADE_EXIT)
})
