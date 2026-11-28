/** rt-1 (ADR-0018 decision 1): `system workers` reads the Worker registry; a Runtime that only registers a Worker is listed with its quota. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capabilities } from '../../work/src/registry.ts'
import { workersView } from '../src/index.ts'

const ctxOf = (capabilities: Capabilities) => ({ get: (name: string) => (name === 'capabilities' ? capabilities : undefined) }) as never

test('a Worker registered through Capabilities alone is listed with its status, version and quota', async () => {
  const capabilities = new Capabilities()
  capabilities.registerWorker({
    ref: 'fake/one',
    capabilities: ['research'],
    status: () => ({ runtime: 'fake', available: true, reason: 'registered', capabilities: ['research'] }),
    version: async () => '1.2.3',
    quota: async () => ({ windows: { five_hour: { percentUsed: 12, resetsAt: '2026-11-28T10:00:00.000Z' } } }),
    run: async () => ({ status: 'failed', outputs: {} }),
  })
  const view = await workersView(ctxOf(capabilities))
  assert.deepEqual(view.registered, ['fake/one'])
  assert.deepEqual(view.accounts, [{ ref: 'fake/one', runtime: 'fake', available: true, reason: 'registered', capabilities: ['research'], version: '1.2.3', quota: { windows: { five_hour: { percentUsed: 12, resetsAt: '2026-11-28T10:00:00.000Z' } } } }])
})

test('a Worker without a view is listed as available with its capabilities, and a failed quota read is unreadable', async () => {
  const capabilities = new Capabilities()
  capabilities.registerWorker({ ref: 'fake/bare', capabilities: ['x'], run: async () => ({ status: 'failed', outputs: {} }) })
  capabilities.registerWorker({ ref: 'fake/broken', capabilities: ['x'], quota: async () => { throw new Error('boom') }, run: async () => ({ status: 'failed', outputs: {} }) })
  const { accounts } = await workersView(ctxOf(capabilities))
  assert.deepEqual(accounts.map((a) => [a.ref, a.available, a.capabilities]), [['fake/bare', true, ['x']], ['fake/broken', true, ['x']]])
  assert.deepEqual(accounts[1]!.quota, { unreadable: 'the quota read failed' })
})

test('a listed Account that is not a Worker yet shows its reason; its Worker, once registered, takes over', async () => {
  const capabilities = new Capabilities()
  capabilities.registerListing({ ref: 'fake/late', status: () => ({ runtime: 'fake', available: false, reason: 'registering', capabilities: ['x'], label: 'L' }), quota: async () => ({ unreadable: 'still registering' }) })
  assert.deepEqual((await workersView(ctxOf(capabilities))).accounts.map((a) => [a.reason, a.quota]), [['registering', { unreadable: 'still registering' }]])
  capabilities.registerWorker({ ref: 'fake/late', capabilities: ['x'], status: () => ({ runtime: 'fake', available: true, reason: 'registered', capabilities: ['x'] }), run: async () => ({ status: 'failed', outputs: {} }) })
  const { accounts } = await workersView(ctxOf(capabilities))
  assert.equal(accounts.length, 1)
  assert.deepEqual([accounts[0]!.reason, accounts[0]!.label], ['registered', 'L'])
})
