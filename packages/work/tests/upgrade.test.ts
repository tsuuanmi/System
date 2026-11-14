import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { WorkRecord } from '../src/record.ts'
import { assertConsistent, fixture, unfinished } from '../../../test-support/fixture.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-upgrade-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let homes = 0
const newHome = () => { const path = join(dir, `home-${homes++}`); mkdirSync(path); return path }
const quiet = () => new Promise((resolve) => setTimeout(resolve, 30))

test('a draining Host starts no new attempt, lets the running one finish, and names the Works it held', { timeout: 120_000 }, async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  const { id } = await host.submit(f.admission('brainstorm.yaml'))
  f.hold('idea-a')
  const running = host.run(id)
  await f.arrived('idea-a')
  await until(() => f.attempts.includes('idea-b'))
  const draining = host.view.drain()
  // The Work admitted while draining is accepted and its run begins, but nothing of it is dispatched.
  const later = await host.submit(f.admission('brainstorm.yaml'))
  void host.run(later.id)
  await quiet()
  assert.deepEqual(f.attempts, ['idea-a', 'idea-b'])
  let drained = false
  void draining.then(() => { drained = true })
  await quiet()
  assert.equal(drained, false, 'an attempt is still running')

  f.release('idea-a')
  await draining
  assert.deepEqual(f.attempts, ['idea-a', 'idea-b'], 'the synthesis waits for the new code')
  assert.deepEqual((await host.view.held()).sort(), [id, later.id].sort())
  assertConsistent(f, id)
  void running.catch(() => {})
  await host.close()
})

test('a Host that starts after a crash runs on the Work that was waiting, and not the one whose attempt was lost', { timeout: 120_000 }, async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  const waiting = await first.submit(f.admission('brainstorm.yaml'))
  const cut = await first.submit(f.admission('brainstorm.yaml'))
  f.hold('idea-b')
  void first.run(cut.id).catch(() => {})
  await f.arrived('idea-b')
  // A Host killed mid-attempt: `cut` has an attempt that never reported; `waiting` was never dispatched.
  await first.close()
  f.release('idea-b')

  const next = await f.startHost(home)
  // The lost attempt's process is confirmed gone only after start, so `cut` stays interrupted.
  for (const event of cutEvents(next.view.get(cut.id)!)) f.gone(event)
  await until(() => next.view.get(waiting.id)!.state.status === 'succeeded')
  assert.deepEqual(next.resume([waiting.id, cut.id]), [], 'one finished, one interrupted: nothing to resume')
  assert.notEqual(next.view.get(cut.id)!.state.status, 'succeeded')
  await next.close()
})

test('a Work already driven when the Host starts is not run twice, and a held Work stays held', { timeout: 120_000 }, async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  const waiting = await first.submit(f.admission('brainstorm.yaml'))
  await first.close()

  const next = await f.startHost(home)
  await until(() => next.view.get(waiting.id)!.state.status === 'succeeded')
  const attempts = f.attempts.length
  assert.deepEqual(next.resume([waiting.id]), [], 'finished Work is not started again')
  await quiet()
  assert.equal(f.attempts.length, attempts)
  await next.close()
})

const cutEvents = (record: WorkRecord) => record.events.flatMap((e) => (e.type === 'dispatched' ? [e.attemptId] : []))

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 12_000 && !condition(); tries++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(condition(), true)
}
