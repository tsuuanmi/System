import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { assertConsistent, caller, fixture, seeded, type Fixture } from '../../../test-support/fixture.ts'
import { commitLane } from '../src/lane.ts'
import { fold, workRecordSchema, type WorkRecord } from '../src/record.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-host-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let homes = 0
const newHome = () => { const path = join(dir, `home-${homes++}`); mkdirSync(path); return path }
const turn = () => new Promise((resolve) => setImmediate(resolve))
const types = (record: WorkRecord) => record.events.map((e) => (e.type === 'terminal' ? `terminal:${e.outcome}` : 'stepId' in e ? `${e.type}:${e.stepId}` : e.type))

test('a second Host on the same home is refused; another home is not; a closed Host frees its home', async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  await assert.rejects(f.startHost(home), /another Host already runs/)
  const other = await f.startHost(newHome())
  await other.close()
  await first.close()
  await (await f.startHost(home)).close()
})

test('the lane runs one section at a time, in order, and a failure does not block the next', async () => {
  const lane = commitLane()
  const log: string[] = []
  const section = (name: string, turns: number, fails = false) => lane(async () => {
    log.push(`start ${name}`)
    for (let n = 0; n < turns; n++) await turn()
    log.push(`end ${name}`)
    if (fails) throw new Error(name)
  })
  const [a, b, c] = [section('a', 5, true), section('b', 0), section('c', 2)]
  await assert.rejects(a, /a/)
  await Promise.all([b, c])
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
})

test('run and cancel submitted together: the cancel is decided first, so nothing is dispatched', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  const running = host.run(id)
  assert.equal(await host.cancel(id, { caller, reason: 'stop' }), 'requested')
  assert.deepEqual(types(await running), ['admitted', 'terminal:cancelled'])
  assert.deepEqual(f.attempts, [])
  assertConsistent(f, id)
  await host.close()
})

test('a cancel and the report of a held attempt in the same turn: both are recorded, in order, and the record replays', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  f.hold('idea-b')
  const running = host.run(id)
  await f.arrived('idea-b')
  const cancelling = host.cancel(id, { caller, reason: 'stop' })
  f.release('idea-b')
  assert.equal(await cancelling, 'requested')
  assert.deepEqual(types(await running), ['admitted', 'dispatched:idea-a', 'observed:idea-a', 'dispatched:idea-b', 'observed:idea-b', 'terminal:cancelled'])
  assertConsistent(f, id)
  await host.close()
})

test('writes of different Works never overlap: every change goes through the one lane', async () => {
  const f = fixture({ seed: 3 })
  let writing = 0
  let most = 0
  const counted = async <T>(write: () => Promise<T>) => {
    most = Math.max(most, ++writing)
    try { return await write() } finally { writing-- }
  }
  const { put, update } = f.table
  f.table.put = (key, value) => counted(() => put.call(f.table, key, value))
  f.table.update = (key, fn) => counted(() => update.call(f.table, key, fn))
  const host = await f.startHost(newHome())
  const ids = await Promise.all(['brainstorm.yaml', 'software-engineering.yaml', 'brainstorm.yaml'].map(async (file) => (await host.submit(f.admission(file))).id))
  await Promise.all(ids.map((id) => host.run(id)))
  assert.equal(most, 1)
  for (const id of ids) assertConsistent(f, id)
  await host.close()
})

test('two runs of one Work together: one drives it, the other is refused, nothing interleaves', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  const results = await Promise.allSettled([host.run(id), host.run(id)])
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected'])
  assert.equal(f.attempts.length, 3)
  assertConsistent(f, id)
  await host.close()
})

for (let seed = 1; seed <= 20; seed++) {
  test(`seed ${seed}: run, cancel and run again at random moments lose and repeat no event`, async () => {
    const f = fixture({ seed })
    const host = await f.startHost(newHome())
    const { id } = await host.submit(f.admission('software-engineering.yaml'))
    const random = seeded(seed + 1000)
    const running = host.run(id)
    for (let n = Math.floor(random() * 30); n > 0; n--) await turn()
    const settled = await Promise.allSettled([host.cancel(id, { caller, reason: 'stop' }), host.run(id), running])
    assert.equal(settled[2]!.status, 'fulfilled')
    assertConsistent(f, id)
    await host.close()
  })
}

test('a closed Host writes nothing, even when its attempt reports late', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  f.hold('idea-a')
  const running = host.run(id)
  await f.arrived('idea-a')
  await host.close()
  f.release('idea-a')
  await assert.rejects(running, /Host is closed/)
  assert.deepEqual(types(f.controller.get(id)!), ['admitted', 'dispatched:idea-a'])
  await assert.rejects(host.run(id), /Host is closed/)
})

test('submitting twice with one commandId gives one Work; its ID derives from the commandId', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const first = await host.submit(f.admission('brainstorm.yaml'), { commandId: 'cmd-1' })
  const again = await host.submit(f.admission('brainstorm.yaml'), { commandId: 'cmd-1' })
  assert.equal(again.id, first.id)
  assert.equal(host.list().length, 1)
  assert.equal(first.events.length, 1)
  assert.match(first.id, /^work:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const elsewhere = fixture()
  const elsewhereHost = await elsewhere.startHost(newHome())
  assert.equal((await elsewhereHost.submit(elsewhere.admission('brainstorm.yaml'), { commandId: 'cmd-1' })).id, first.id, 'the same commandId gives the same ID in another store')
  await elsewhereHost.close()
  assert.notEqual((await host.submit(f.admission('brainstorm.yaml'), { commandId: 'cmd-2' })).id, first.id)
  await host.close()
})

test('without a commandId every submit is a new Work', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const a = await host.submit(f.admission('brainstorm.yaml'))
  const b = await host.submit(f.admission('brainstorm.yaml'))
  assert.notEqual(a.id, b.id)
  assert.equal(a.receipts, undefined)
  await host.close()
})

test('submit sent twice at once gives one Work', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const [a, b] = await Promise.all([host.submit(f.admission('brainstorm.yaml'), { commandId: 'cmd-1' }), host.submit(f.admission('brainstorm.yaml'), { commandId: 'cmd-1' })])
  assert.equal(a.id, b.id)
  assert.equal(host.list().length, 1)
  await host.close()
})

test('the same commandId with different arguments is refused', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const admission = f.admission('brainstorm.yaml')
  const { id } = await host.submit(admission, { commandId: 'cmd-1' })
  await assert.rejects(host.submit({ ...admission, caller: { type: 'human', operatorId: 'someone-else' } }, { commandId: 'cmd-1' }), /commandId cmd-1 .* different arguments/)
  await assert.rejects(host.run(id, { commandId: 'cmd-1' }), /commandId cmd-1 .* different arguments/)
  const { id: other } = await host.submit(f.admission('software-engineering.yaml'))
  await host.run(id, { commandId: 'cmd-2' })
  await assert.rejects(host.run(other, { commandId: 'cmd-2' }), /commandId cmd-2 .* different arguments/)
  assert.equal(f.controller.get(other)!.events.length, 1, 'the refused run did nothing')
  await host.close()
})

test('the same run twice dispatches once', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  const first = await host.run(id, { commandId: 'run-1' })
  const again = await host.run(id, { commandId: 'run-1' })
  assert.equal(first.state.status, 'succeeded')
  assert.equal(again.state.status, 'succeeded')
  assert.equal(f.attempts.length, 3)
  assert.equal(f.controller.get(id)!.events.length, first.events.length)
  await host.close()
})

test('the same run sent twice while it runs joins it', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  const [a, b] = await Promise.all([host.run(id, { commandId: 'run-1' }), host.run(id, { commandId: 'run-1' })])
  assert.equal(a.state.status, b.state.status)
  assert.equal(f.attempts.length, 3)
  await host.close()
})

test('a refusal is remembered: the same retry again gives the same error, a different one is refused', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  await host.run(id)
  const args = { caller, reason: 'again', commandId: 'retry-1' }
  const first = await host.retry(id, args).catch((error: Error) => error)
  assert.match((first as Error).message, /only failed, cancelled or held Work is retried/)
  assert.equal(await host.retry(id, args).catch((error: Error) => error), first)
  await assert.rejects(host.retry(id, { ...args, reason: 'other' }), /different arguments/)
  await host.close()
})

test('a receipt is stored in the Work record, in the update of the event that caused it, and survives a restart', async () => {
  const f = fixture()
  const updates: { events: number; receipts: number }[] = []
  const update = f.table.update.bind(f.table)
  let last = { events: 0, receipts: 0 }
  f.table.update = async (key, fn) => {
    const next = await update(key, fn)
    const now = { events: next.events.length, receipts: next.receipts?.length ?? 0 }
    if (now.receipts !== last.receipts) updates.push({ events: now.events - last.events, receipts: now.receipts })
    last = now
    return next
  }
  const home = newHome()
  const host = await f.startHost(home)
  const { id } = await host.submit(f.admission('brainstorm.yaml'), { commandId: 'sub-1' })
  last = { events: 1, receipts: 1 }
  await host.run(id, { commandId: 'run-1' })
  assert.deepEqual(updates, [{ events: 1, receipts: 2 }], 'the receipt grew in the update that appended the terminal event')
  const stored = f.controller.get(id)!
  assert.equal(stored.events.at(-1)!.type, 'terminal')
  assert.deepEqual(stored.receipts!.map((r) => [r.commandId, r.result]), [['sub-1', { workId: id, status: 'running' }], ['run-1', { workId: id, status: 'succeeded' }]])
  await host.close()

  const restarted = await f.startHost(home)
  const attempts = f.attempts.length
  const again = await restarted.run(id, { commandId: 'run-1' })
  assert.equal(again.state.status, 'succeeded')
  assert.equal(f.attempts.length, attempts)
  assert.equal((await restarted.submit(f.admission('brainstorm.yaml'), { commandId: 'sub-1' })).id, id)
  await assert.rejects(restarted.run(id, { commandId: 'sub-1' }), /different arguments/)
  await restarted.close()
})

test('a cancel that is only requested is receipted with the terminal event it leads to', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  f.hold('idea-a')
  const running = host.run(id, { commandId: 'run-1' })
  await f.arrived('idea-a')
  assert.equal(await host.cancel(id, { caller, reason: 'stop', commandId: 'cancel-1' }), 'requested')
  f.release('idea-a')
  await running
  assert.deepEqual(f.controller.get(id)!.receipts!.map((r) => [r.commandId, r.result.status]), [['run-1', 'cancelled'], ['cancel-1', 'cancelled']])
  assert.equal((await host.cancel(id, { caller, reason: 'stop', commandId: 'cancel-1' })), 'requested')
  await host.close()
})

test('a cancel that is recorded directly is receipted too', async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  const done = await host.cancel(id, { caller, reason: 'stop', commandId: 'cancel-1' })
  assert.notEqual(done, 'requested')
  assert.deepEqual(f.controller.get(id)!.receipts!.map((r) => r.commandId), ['cancel-1'])
  await host.close()
})

test('records written before receipts are still valid; a record with them is too', async () => {
  const f = fixture()
  const record = await f.admit('brainstorm.yaml')
  assert.equal(workRecordSchema.parse(record).receipts, undefined)
  const receipt = { commandId: 'c', args: 'a'.repeat(64), result: { workId: record.id, status: 'running' as const } }
  assert.deepEqual(workRecordSchema.parse({ ...record, receipts: [receipt] }).receipts, [receipt])
  assert.equal(workRecordSchema.safeParse({ ...record, receipts: [{ ...receipt, result: { workId: record.id } }] }).success, false)
})

/** A Host killed (simulated: closed) while idea-b is held at its barrier, and a new Host on the same store. */
async function killedMidAttempt(f: Fixture, home: string) {
  const first = await f.startHost(home)
  const { id } = await first.submit(f.admission('brainstorm.yaml'))
  f.hold('idea-b')
  const running = first.run(id, { commandId: 'run-1' })
  await f.arrived('idea-b')
  await first.close()
  f.release('idea-b')
  await assert.rejects(running, /Host is closed/)
  return { id, second: await f.startHost(home) }
}

test('a Host killed mid-attempt: the new Host marks the attempt lost, does not run the Work, and an explicit run continues it', async () => {
  const f = fixture()
  const { id, second } = await killedMidAttempt(f, newHome())
  const record = second.get(id)!
  assert.deepEqual(types(record), ['admitted', 'dispatched:idea-a', 'observed:idea-a', 'dispatched:idea-b', 'attempt-lost:idea-b'])
  assert.equal(record.state.status, 'running')
  assert.deepEqual(second.interrupted(), [id])
  assert.deepEqual(second.uncertain(), [{ workId: id, stepId: 'idea-b', attemptId: record.state.steps['idea-b']!.attempts[0]! }])
  for (let n = 0; n < 20; n++) await turn()
  assert.deepEqual(f.attempts, ['idea-a', 'idea-b'], 'nothing is dispatched by itself')
  const done = await second.run(id, { commandId: 'run-1' })
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(f.attempts, ['idea-a', 'idea-b', 'idea-b', 'synthesis'])
  assert.deepEqual(second.interrupted(), [])
  assertConsistent(f, id)
  await second.close()
})

test('a Work that finished is not marked, and a held Work stays held', async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  const { id } = await first.submit(f.admission('brainstorm.yaml'))
  await first.run(id)
  const events = first.get(id)!.events.length
  await first.close()
  const second = await f.startHost(home)
  assert.equal(second.get(id)!.events.length, events)
  assert.deepEqual(second.interrupted(), [])
  await second.close()
})

/** A Software Engineering Work whose publish effect was intended and never observed. */
function intendedEffect(f: Fixture, record: WorkRecord): WorkRecord {
  const cut = record.events.findIndex((e) => e.type === 'effect-intended') + 1
  const events = record.events.slice(0, cut)
  const stored = { ...record, events, state: fold(f.controller.specOf(record).steps.map((s) => s.id), events) }
  f.table.rows.set(record.id, workRecordSchema.parse(stored))
  return stored
}

test('an effect left intended is reconciled on start, and an applied one is not applied again', async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  const { id } = await first.submit(f.admission('software-engineering.yaml'))
  intendedEffect(f, await first.run(id))
  await first.close()
  f.remote.state = 'applied'
  const second = await f.startHost(home)
  const record = second.get(id)!
  assert.equal(Object.values(record.state.effects)[0]!.state, 'applied')
  assert.equal(record.state.status, 'running', 'it is not resumed by itself')
  assert.equal(record.events.at(-1)!.type, 'effect-observed')
  assert.equal(record.events.filter((e) => e.type === 'effect-intended').length, 1)
  const done = await second.run(id)
  assert.equal(done.state.status, 'succeeded')
  assert.equal(done.events.filter((e) => e.type === 'effect-intended').length, 1, 'the publish is not redone')
  await second.close()
})

test('an effect found absent on start is published only by an explicit run', async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  const { id } = await first.submit(f.admission('software-engineering.yaml'))
  intendedEffect(f, await first.run(id))
  await first.close()
  const second = await f.startHost(home)
  assert.equal(Object.values(second.get(id)!.state.effects)[0]!.state, 'absent')
  assert.equal(second.get(id)!.state.status, 'running')
  const done = await second.run(id)
  assert.equal(done.state.status, 'succeeded')
  assert.equal(Object.values(done.state.effects)[0]!.state, 'applied')
  assertConsistent(f, id)
  await second.close()
})

test('an effect whose outcome stays unknown holds the Work when it is run', async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  const { id } = await first.submit(f.admission('software-engineering.yaml'))
  intendedEffect(f, await first.run(id))
  await first.close()
  f.remote.state = 'unknown'
  const second = await f.startHost(home)
  assert.equal(Object.values(second.get(id)!.state.effects)[0]!.state, 'unknown')
  assert.equal((await second.run(id)).state.status, 'held')
  await second.close()
})
