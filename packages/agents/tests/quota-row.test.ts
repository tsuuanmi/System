/** Quota on the agents row: registration stays lazy; each account owns its read/cache. */
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeClaudeHome, fakeCodexHome, tempDir } from '../../../test-support/accounts.ts'
import { claudeUsage, codexRateLimits, fakeQuotaCli, object } from '../../../test-support/quota.ts'
import { apply, type AccountConfig, type AgentsService, type Config } from '../src/index.ts'

async function mount(dir: string, accounts: AccountConfig[], now: () => number) {
  const services: Record<string, unknown> = {
    artifacts: {},
    subprocess: { resolveExecutable: async (c: string): Promise<string> => c, spawn: (): never => { throw new Error('registration must not spawn') } },
    credentials: { describe: async (): Promise<{ configured: boolean }> => ({ configured: true }), resolve: async (): Promise<{ value: string }> => ({ value: 'tok-1' }) },
    capabilities: { registerWorker: (_worker: unknown): (() => void) => () => {} },
  }
  let agents: unknown
  const ctx = { baseDir: dir, get: (key: string): unknown => services[key], effect: (_fn: () => () => void): void => {}, provide: (key: string, value: unknown): void => { if (key === 'agents') agents = value } }
  // The optional quota clock is the plan's test seam, added by implement.
  const config: Config & { quota: { now: () => number } } = { accounts, quota: { now } }
  await apply(ctx as never, config)
  const row = object(agents)
  assert.equal(typeof row.quota, 'function', 'AgentsService.quota must be exposed')
  return agents as AgentsService & { quota(ref: string): Promise<unknown> }
}
function claude(dir: string, version = '2.1.322') {
  const home = fakeClaudeHome(join(dir, 'claude-home'), { accountUuid: 'claude-account' })
  const fake = fakeQuotaCli(join(dir, 'claude-cli'), { kind: 'claude', version, answer: claudeUsage({ five_hour: { utilization: 42, resets_at: null } }) })
  const spec: AccountConfig = { ref: 'claude-code/c1', runtime: 'claude-code', capabilities: ['research'], command: fake.command, claudeHome: home }
  return { home, fake, spec }
}
function codex(dir: string) {
  const home = fakeCodexHome(join(dir, 'codex-home'), 'codex-account')
  const fake = fakeQuotaCli(join(dir, 'codex-cli'), { kind: 'codex', version: '0.166.0', answer: codexRateLimits({ primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: null } }) })
  const spec: AccountConfig = { ref: 'codex/x1', runtime: 'codex', capabilities: ['research'], command: fake.command, codexHome: home }
  return { home, fake, spec }
}
test('the agents row caches a Claude reading for ten minutes then rereads', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { spec, fake } = claude(dir)
  let now = Date.parse('2026-11-10T12:00:00.000Z')
  const row = await mount(dir, [spec], () => now)
  assert.equal(existsSync(fake.log), false)
  const first = await row.quota(spec.ref)
  assert.deepEqual(first, { observedAt: new Date(now).toISOString(), windows: { five_hour: { percentUsed: 42 } } })
  const firstLog = fake.readLog()
  assert.deepEqual(firstLog[0]?.argv, ['--version'])
  assert.equal(firstLog.filter((entry) => entry.stdin !== undefined).length, 1)
  assert.deepEqual(await row.quota(spec.ref), first)
  assert.deepEqual(fake.readLog(), firstLog)
  now += 600_001
  assert.deepEqual(await row.quota(spec.ref), { observedAt: new Date(now).toISOString(), windows: { five_hour: { percentUsed: 42 } } })
  assert.equal(fake.readLog().filter((entry) => entry.stdin !== undefined).length, 2)
})
test('two accounts read independently from their own homes and logs', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const c = claude(dir)
  const x = codex(dir)
  const row = await mount(dir, [c.spec, x.spec], () => Date.parse('2026-11-10T12:00:00Z'))
  assert.deepEqual(object(await row.quota(c.spec.ref)).windows, { five_hour: { percentUsed: 42 } })
  assert.equal(existsSync(x.fake.log), false)
  assert.deepEqual(object(await row.quota(x.spec.ref)).windows, { five_hour: { percentUsed: 17 } })
  for (const account of [c, x]) {
    const launches = account.fake.readLog().filter((entry) => entry.home !== undefined)
    assert.equal(launches.length, 1)
    assert.equal(launches[0]?.home, account.home)
  }
  assert.equal(x.fake.readLog().find((entry) => entry.codexHome !== undefined)?.codexHome, x.home)
  assert.equal(c.fake.readLog().filter((entry) => entry.stdin !== undefined).length, 1)
  assert.deepEqual(x.fake.readLog().filter((entry) => entry.stdin !== undefined).map((entry) => object(entry.stdin).method), ['initialize', 'initialized', 'account/rateLimits/read'])
})
test('listing accounts spawns no quota reader; web and unknown refs are unreadable', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const c = claude(dir)
  const x = codex(dir)
  const web: AccountConfig = { ref: 'web/chatgpt/x', runtime: 'web', site: 'chatgpt', capabilities: ['research'] }
  const row = await mount(dir, [c.spec, x.spec, web], () => 0)
  const statuses = await row.accounts()
  assert.deepEqual(statuses, [
    { ref: c.spec.ref, runtime: 'claude-code', capabilities: ['research'], models: {}, priority: 'secondary', available: true, reason: 'registered', command: c.fake.command, providerAccount: 'claude-account', version: '' },
    { ref: x.spec.ref, runtime: 'codex', capabilities: ['research'], models: {}, priority: 'secondary', available: true, reason: 'registered', command: x.fake.command, providerAccount: 'codex-account', version: '' },
    { ref: web.ref, runtime: 'web', capabilities: ['research'], models: {}, priority: 'secondary', available: false, reason: 'the web-worker row is disabled' },
  ])
  for (const ref of [web.ref, 'unknown']) assert.deepEqual(await row.quota(ref), { unreadable: `no quota reader for ${ref}` })
  assert.equal(existsSync(c.fake.log), false)
  assert.equal(existsSync(x.fake.log), false)
})
test('an unknown version on the row only runs --version', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { spec, fake } = claude(dir, '2.1.999')
  const row = await mount(dir, [spec], () => 0)
  const report = object(await row.quota(spec.ref))
  assert.deepEqual(Object.keys(report), ['unreadable'])
  assert.ok(typeof report.unreadable === 'string')
  assert.match(report.unreadable, /2\.1\.999.*not verified/)
  assert.deepEqual(fake.readLog(), [{ argv: ['--version'] }])
})
