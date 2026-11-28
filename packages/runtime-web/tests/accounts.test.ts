/**
 * ADR-0018 decision 3: the `runtime-web` row owns its Accounts in its own `config.accounts` and registers its own Workers; it reads no other
 * Runtime's config, so there is nothing to hand over and nothing to wait for. A refused Account is listed with its reason and the others go on.
 * No browser: these are refused before one is looked for.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { shippedMap } from '@system/web-driver'
import { apply, offeredTiers, type AccountConfig } from '../src/index.ts'

interface Listing { ref: string; status(): { runtime: string; available: boolean; reason: string; abilities?: string[]; capabilities: string[]; label?: string; note?: string }; quota?(fresh?: boolean): Promise<unknown> }

/** Mount the row on a bare context with these Accounts; what it listed, which Workers it registered, and whether it read a service of another Runtime. */
function mount(accounts: Partial<AccountConfig>[], row: { attemptTimeoutMinutes?: number } = {}, home = '/nonexistent') {
  const listings: Listing[] = []
  const workers: string[] = []
  const read: string[] = []
  const services: Record<string, unknown> = {
    capabilities: { registerListing: (listing: Listing) => { listings.push(listing); return () => {} }, registerWorker: (worker: { ref: string }) => { workers.push(worker.ref); return () => {} } },
    artifacts: {}, subprocess: {}, dshHomePath: (...segments: string[]) => join(home, ...segments),
  }
  const ctx = { get: (key: string) => { read.push(key); return services[key] }, registry: { values: () => [] }, effect: () => {}, provide: () => {} }
  apply(ctx as never, { ...row, accounts: accounts.map((own) => ({ ref: 'web/chatgpt/default', runtime: 'web', site: 'chatgpt', capabilities: ['research'], ...own })) })
  return { listings, workers, read }
}

test('every Account of the row is listed from its own config, with the web abilities and what the profile grants', () => {
  const { listings } = mount([{ label: 'main', priority: 'primary', procedures: 'x' } as never, { ref: 'web/chatgpt/second', capabilities: ['research.lane-b'] }])
  assert.deepEqual(listings.map((l) => l.ref), ['web/chatgpt/default', 'web/chatgpt/second'])
  const [first, second] = listings.map((l) => l.status())
  assert.deepEqual([first!.runtime, first!.abilities, first!.capabilities, first!.label, first!.note], ['web', ['web.search', 'web.browse'], ['research'], 'main', 'priority is ignored: routing goes by quota headroom'])
  assert.deepEqual([second!.abilities, second!.capabilities], [['web.search', 'web.browse'], ['research.lane-b']])
})

test('a web Account has no quota reader', async () => {
  const { listings } = mount([{}])
  assert.deepEqual(await listings[0]!.quota!(), { unreadable: 'a web account has no quota reader' })
})

test('the row reads only the services it injects, never another Runtime\'s', () => {
  const { read } = mount([{}])
  assert.deepEqual([...new Set(read)].sort(), ['artifacts', 'capabilities', 'dshHomePath', 'subprocess'].sort())
})

test('an Account the row refuses is listed unavailable with its reason, registers no Worker, and the others are still tried', () => {
  const { listings, workers } = mount([
    { ref: 'web/gemini/default', site: 'gemini' },
    { ref: 'web/default' },
    { site: undefined },
    { runtime: 'codex' },
    { maxConcurrentAttempts: 2 },
  ])
  const reasons = listings.map((l) => l.status().reason)
  assert.equal(reasons.length, 5)
  assert.equal(reasons[0], 'unknown site gemini; the shipped sites are: chatgpt')
  assert.match(reasons[1]!, /ref web\/default does not match site chatgpt/)
  assert.equal(reasons[2], 'a web account names its site (site: chatgpt)')
  assert.match(reasons[3]!, /runtime is codex/)
  assert.deepEqual(workers, [])
  assert.ok(listings.every((l) => !l.status().available))
})

// WW2-iv: the legacy driver is gone, and the option that chose between it and the generic Procedures with it. It is refused before any browser is looked for.
test('an account that still sets procedures, either value, is refused with the reason', () => {
  const { listings } = mount(['legacy', 'generic', 'Generic'].map((procedures) => ({ procedures }) as never))
  for (const listing of listings) assert.match(listing.status().reason, /procedures was removed: the generic Procedures are the only path; delete the line/)
})

test('a web Account runs one attempt at a time, whatever it says', () => {
  const { listings } = mount([{ maxConcurrentAttempts: 2 }])
  assert.match(listings[0]!.status().reason, /a web account runs one attempt at a time \(one Chrome profile\); maxConcurrentAttempts must be 1/)
})

// WW8b: an Account offers the tiers when its Site map binds a Power control and the generic Procedures run it, as a CLI Account offers them from `models`.
test('a web account offers the three tiers when the map binds Power', () => {
  const map = shippedMap()
  assert.deepEqual(offeredTiers(map), ['tier.economy', 'tier.standard', 'tier.frontier'])
  assert.deepEqual(offeredTiers({ ...map, actions: { ...map.actions, 'model.close': undefined as never } }), [], 'a map without the control')
  const { 'model.power': _, ...elements } = map.elements
  assert.deepEqual(offeredTiers({ ...map, elements }), [])
})
