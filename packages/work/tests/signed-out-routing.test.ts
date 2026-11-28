/** authgate-1: routing skips an Account whose quota read is signed out, and takes it again once a read succeeds. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rankByHeadroom, roomOf, type QuotaReading } from '../src/headroom.ts'
import { Capabilities } from '../src/registry.ts'

const signedOut: QuotaReading = { unreadable: 'usage failed: authentication failed or timed out', signedOut: true }
const unknown: QuotaReading = { unreadable: 'it reports neither five_hour nor seven_day' }
const ok: QuotaReading = { windows: { five_hour: { percentUsed: 10 } } }
const rank = (...readings: (QuotaReading | undefined)[]) => rankByHeadroom(readings.map((reading, n) => ({ ref: `a${n}`, attempts: 0, reading, ceiling: 80 })))

test('a signed-out Account is not chosen, even over a merely unknown one', () => {
  const ranking = rank(signedOut, unknown)
  assert.equal(ranking.selected, 'a1')
  assert.equal(ranking.reasons.a0, 'unavailable: signed out')
})

test('an Account whose quota is merely unknown (no window, a web Account) is still chosen', () => {
  assert.equal(rank(unknown).selected, 'a0')
  assert.equal(rank(undefined).selected, 'a0')
})

test('when every Account is signed out the step waits instead of failing', () => {
  const ranking = rank(signedOut, signedOut)
  assert.equal(ranking.selected, undefined)
  assert.deepEqual(ranking.waitUntil, {})
})

test('a later successful read makes the Account chosen again', () => {
  assert.equal(rank(signedOut).selected, undefined)
  assert.equal(rank(ok).selected, 'a0')
})

test('routeWorker skips the signed-out Account and names why', () => {
  const caps = new Capabilities()
  for (const ref of ['agy/1', 'agy/2']) caps.registerWorker({ ref, capabilities: ['code'], run: async () => ({ status: 'succeeded', outputs: {} }) })
  const route = caps.routeWorker(['code'], undefined, undefined, new Map<string, QuotaReading>([['agy/1', signedOut], ['agy/2', ok]]))
  assert.equal(route.selected?.ref, 'agy/2')
  assert.equal(route.candidates.find((c) => c.ref === 'agy/1')?.reason, 'unavailable: signed out')
  const none = caps.routeWorker(['code'], undefined, undefined, new Map<string, QuotaReading>([['agy/1', signedOut], ['agy/2', signedOut]]))
  assert.equal(none.selected, undefined)
  assert.deepEqual(none.quotaWait, {})
})

test('a signed-out Account is not room', () => {
  assert.deepEqual(roomOf([{ ref: 'a', slot: true, reading: signedOut, ceiling: 80 }, { ref: 'b', slot: true, reading: unknown, ceiling: 80 }]), { accounts: 2, free: 1, unknown: ['b'] })
})
