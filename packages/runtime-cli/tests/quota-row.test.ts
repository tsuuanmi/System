/** Quota on the agents row: registration stays lazy; each account owns its read/cache. */
import assert from 'node:assert/strict'
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeClaudeHome, fakeCodexHome, tempDir } from '../../../test-support/accounts.ts'
import { claudeUsage, codexRateLimits, fakeQuotaCli, object } from '../../../test-support/quota.ts'
import { apply, type AccountConfig, type Config } from '../src/index.ts'
import { observed, viewOf } from '../../../test-support/accounts-view.ts'
import type { WorkerPort } from '../../work/src/registry.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { webDefaults, webWorker } from '../../runtime-web/src/chatgpt.ts'

/** The fake context's `ctx.inject`: the declared services are the ones in `services`, mounted at once. */
const injecting = (services: Record<string, unknown>) => (_names: string[], callback: (ctx: { get(key: string): unknown }) => void): void => { callback({ get: (key) => services[key] }) }

async function mount(dir: string, accounts: AccountConfig[], now: () => number, options: { ports?: WorkerPort[]; quotaCeilingPercent?: unknown; configured?: boolean; token?: string } = {}) {
  const capabilities = observed((worker) => { options.ports?.push(worker) })
  const services: Record<string, unknown> = {
    storageDomain: { open: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }) },
    dshHomePath: (...segments: string[]) => join(dir, ...segments),
    artifacts: {},
    subprocess: { resolveExecutable: async (c: string): Promise<string> => c, spawn: (): never => { throw new Error('registration must not spawn') } },
    credentials: { describe: async (): Promise<{ configured: boolean }> => ({ configured: options.configured ?? true }), resolve: async (): Promise<{ value: string }> => ({ value: options.token ?? 'tok-1' }) },
    capabilities,
  }
  let agents: unknown
  const ctx = { baseDir: dir, get: (key: string): unknown => services[key], inject: injecting(services), effect: (_fn: () => () => void): void => {}, provide: (key: string, value: unknown): void => { if (key === 'agents') agents = value } }
  // The optional quota clock is the plan's test seam, added by implement.
  // Unknown allows deliberately invalid configuration values at this boundary.
  const config = { accounts, quota: { now }, ...(options.quotaCeilingPercent === undefined ? {} : { quotaCeilingPercent: options.quotaCeilingPercent }) }
  await apply(ctx as never, config as Config)
  const row = object(agents)
  return { ...viewOf(capabilities), quota: (ref: string) => viewOf(capabilities).quota(ref) as Promise<unknown> }
}
function claude(dir: string, version = '2.1.322') {
  const home = fakeClaudeHome(join(dir, 'claude-home'), { accountUuid: 'claude-account' })
  const fake = fakeQuotaCli(join(dir, 'claude-cli'), { kind: 'claude', version, answer: claudeUsage({ five_hour: { utilization: 42, resets_at: '2026-11-10T14:00:00.000Z' } }) })
  const spec: AccountConfig = { ref: 'claude-code/c1', runtime: 'claude-code', capabilities: ['research'], command: fake.command, claudeHome: home }
  return { home, fake, spec }
}
function codex(dir: string) {
  const home = fakeCodexHome(join(dir, 'codex-home'), 'codex-account')
  const fake = fakeQuotaCli(join(dir, 'codex-cli'), { kind: 'codex', version: '0.166.0', answer: codexRateLimits({ primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1794319200 } }) })
  const spec: AccountConfig = { ref: 'codex/x1', runtime: 'codex', capabilities: ['research'], command: fake.command, codexHome: home }
  return { home, fake, spec }
}
test('the agents row creates a missing claudeHome (mode 700) and the quota reads', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'absent', 'c1')
  const fake = fakeQuotaCli(join(dir, 'claude-cli'), { kind: 'claude', version: '2.1.322', answer: claudeUsage({ five_hour: { utilization: 42, resets_at: '2026-11-10T14:00:00.000Z' } }) })
  const spec: AccountConfig = { ref: 'claude-code/c1', runtime: 'claude-code', capabilities: ['research'], command: fake.command, claudeHome: home }
  const now = Date.parse('2026-11-10T12:00:00.000Z')
  const row = await mount(dir, [spec], () => now)
  assert.ok(existsSync(home), 'registration creates claudeHome before any quota read')
  assert.ok(statSync(home).isDirectory())
  assert.equal(statSync(home).mode & 0o777, 0o700)
  assert.deepEqual(await row.quota(spec.ref), { observedAt: new Date(now).toISOString(), windows: { five_hour: { percentUsed: 42, resetsAt: '2026-11-10T14:00:00.000Z' } }, cliVersion: '2.1.322' })
  assert.equal(fake.readLog().find((entry) => entry.home !== undefined)?.home, home)
})
test('a default claudeHome under $DSH_HOME/system is created too', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = fakeQuotaCli(join(dir, 'claude-cli'), { kind: 'claude', version: '2.1.322', answer: claudeUsage({ five_hour: { utilization: 42, resets_at: '2026-11-10T14:00:00.000Z' } }) })
  const spec: AccountConfig = { ref: 'claude-code/c1', runtime: 'claude-code', capabilities: ['research'], command: fake.command }
  await mount(dir, [spec], () => 0)
  assert.ok(existsSync(join(dir, 'system', 'claude', 'c1')), 'registration creates the default claudeHome in the temporary DSH home')
})
test('the reason names the directory when claudeHome cannot be created', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'blocker'), 'a file cannot contain the account home')
  const home = join(dir, 'blocker', 'c1')
  const fake = fakeQuotaCli(join(dir, 'claude-cli'), { kind: 'claude', version: '2.1.322', answer: claudeUsage({ five_hour: { utilization: 42, resets_at: '2026-11-10T14:00:00.000Z' } }) })
  const spec: AccountConfig = { ref: 'claude-code/c1', runtime: 'claude-code', capabilities: ['research'], command: fake.command, claudeHome: home }
  const ports: WorkerPort[] = []
  const row = await mount(dir, [spec], () => 0, { ports })
  assert.equal(ports.length, 1, 'an uncreatable home still leaves the account registered')
  const report = object(await row.quota(spec.ref))
  assert.deepEqual(Object.keys(report), ['unreadable'])
  assert.ok(typeof report.unreadable === 'string')
  assert.match(report.unreadable, /claudeHome .*blocker.*c1 does not exist/)
  assert.ok(report.unreadable.includes(home), 'the reason includes the account directory')
  assert.doesNotMatch(report.unreadable, /ENOENT|version unreadable/)
})
test('the agents row caches a Claude reading for ten minutes then rereads', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { spec, fake } = claude(dir)
  let now = Date.parse('2026-11-10T12:00:00.000Z')
  const row = await mount(dir, [spec], () => now)
  assert.equal(existsSync(fake.log), false)
  const first = await row.quota(spec.ref)
  assert.deepEqual(first, { observedAt: new Date(now).toISOString(), windows: { five_hour: { percentUsed: 42, resetsAt: '2026-11-10T14:00:00.000Z' } }, cliVersion: '2.1.322' })
  const firstLog = fake.readLog()
  assert.deepEqual(firstLog[0]?.argv, ['--version'])
  assert.equal(firstLog.filter((entry) => entry.stdin !== undefined).length, 1)
  assert.deepEqual(await row.quota(spec.ref), first)
  assert.deepEqual(fake.readLog(), firstLog)
  now += 600_001
  assert.deepEqual(await row.quota(spec.ref), { observedAt: new Date(now).toISOString(), windows: { five_hour: { percentUsed: 42, resetsAt: '2026-11-10T14:00:00.000Z' } }, cliVersion: '2.1.322' })
  assert.equal(fake.readLog().filter((entry) => entry.stdin !== undefined).length, 2)
})
test('two accounts read independently from their own homes and logs', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const c = claude(dir)
  const x = codex(dir)
  const row = await mount(dir, [c.spec, x.spec], () => Date.parse('2026-11-10T12:00:00Z'))
  assert.deepEqual(object(await row.quota(c.spec.ref)).windows, { five_hour: { percentUsed: 42, resetsAt: '2026-11-10T14:00:00.000Z' } })
  assert.equal(existsSync(x.fake.log), false)
  assert.deepEqual(object(await row.quota(x.spec.ref)).windows, { five_hour: { percentUsed: 17, resetsAt: '2026-11-10T14:00:00.000Z' } })
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
    { ref: c.spec.ref, runtime: 'claude-code', abilities: ['repo.read', 'repo.write', 'web.search'], capabilities: ['research'], models: {}, available: true, reason: 'registered', command: c.fake.command, providerAccount: 'claude-account', version: '' },
    { ref: x.spec.ref, runtime: 'codex', abilities: ['repo.read', 'repo.write'], capabilities: ['research'], models: {}, available: true, reason: 'registered', command: x.fake.command, providerAccount: 'codex-account', version: '' },
    { ref: web.ref, runtime: 'web', abilities: ['web.search', 'web.browse'], capabilities: ['research'], models: {}, available: false, reason: 'the web-worker row is disabled' },
  ])
  assert.equal(existsSync(c.fake.log), false)
  assert.equal(existsSync(x.fake.log), false)
})
test('an unknown version on the row is read by the answer shape, with the version beside the reading', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { spec } = claude(dir, '2.1.999')
  const row = await mount(dir, [spec], () => 0)
  const report = object(await row.quota(spec.ref))
  assert.equal(object(object(report.windows).five_hour).percentUsed, 42)
  assert.equal(report.cliVersion, '2.1.999')
  assert.doesNotMatch(JSON.stringify(report), /tok-1|not verified/)
})

test('registered CLI Worker exposes the row\'s quota reading', async (t) => {
  const dir = tempDir('quota-routing-port-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const c = claude(dir)
  const ports: WorkerPort[] = []
  const row = await mount(dir, [c.spec], () => Date.parse('2026-11-10T12:00:00Z'), { ports })
  assert.equal(ports.length, 1)
  const port = ports[0]!
  const quota = Reflect.get(port, 'quota') as (() => Promise<unknown>) | undefined
  assert.equal(typeof quota, 'function', 'registered CLI port exposes quota()')
  assert.deepEqual(await quota!(), await row.quota(c.spec.ref))
  assert.equal(c.fake.readLog().filter((entry) => entry.stdin !== undefined).length, 1, 'port and row share the same cache')
})
for (const value of [0, 101, NaN, '80']) {
  test(`quotaCeilingPercent rejects ${String(value)} (${typeof value}) before registering accounts`, async (t) => {
    const dir = tempDir('quota-ceiling-invalid-')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const c = claude(dir)
    const ports: WorkerPort[] = []
    await assert.rejects(mount(dir, [c.spec], () => 0, { ports, quotaCeilingPercent: value }), /quotaCeilingPercent/)
    assert.deepEqual(ports, [], 'invalid row configuration registers no account')
  })
}
for (const value of [1, 80, 100]) {
  test(`quotaCeilingPercent accepts ${value} and reaches the Worker port`, async (t) => {
    const dir = tempDir('quota-ceiling-valid-')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const c = claude(dir)
    const ports: WorkerPort[] = []
    await mount(dir, [c.spec], () => 0, { ports, quotaCeilingPercent: value })
    assert.equal(ports.length, 1)
    assert.equal(Reflect.get(ports[0]!, 'quotaCeilingPercent'), value)
  })
}
test('web port has no quota; CLI default ceiling is unset', async (t) => {
  const dir = tempDir('quota-ceiling-default-')
  const web = webWorker({ ref: 'web/chatgpt/test', capabilities: ['research'], command: 'fake-chrome', version: async () => 'fake', web: webDefaults(join(dir, 'profile')) }, memoryArtifacts().artifacts, join(dir, 'attempts'))
  assert.equal(Reflect.get(web, 'quota'), undefined, 'web Accounts have no quota reader')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const c = claude(dir)
  const ports: WorkerPort[] = []
  await mount(dir, [c.spec], () => 0, { ports })
  assert.equal(ports.length, 1)
  assert.equal(Reflect.get(ports[0]!, 'quotaCeilingPercent'), undefined)
})

test('quota() of a web account says it has no quota reader', async (t) => {
  const dir = tempDir('quota-web-reason-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const row = await mount(dir, [{ ref: 'web/chatgpt/x', runtime: 'web', site: 'chatgpt', capabilities: ['research'] }], () => 0)
  assert.deepEqual(await row.quota('web/chatgpt/x'), { unreadable: 'a web account has no quota reader' })
})

test('quota() of an account whose registration failed says it is not registered', async (t) => {
  const dir = tempDir('quota-unregistered-reason-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { spec, fake } = claude(dir)
  const row = await mount(dir, [spec], () => 0, { configured: false })
  const report = object(await row.quota(spec.ref))
  assert.equal(typeof report.unreadable, 'string')
  assert.match(String(report.unreadable), /not registered.*token.*not configured/)
  assert.doesNotMatch(JSON.stringify(report), /tok-1/)
  assert.equal(existsSync(fake.log), false)
  // Registration can also succeed before the token disappears at read time.
  const noToken = await mount(dir, [spec], () => 0, { token: '' })
  const missing = await noToken.quota(spec.ref)
  assert.deepEqual(missing, { unreadable: 'its token is not configured' })
  assert.doesNotMatch(JSON.stringify(missing), /tok-1/)
  assert.equal(existsSync(fake.log), false)
})
test('an Account whose get_usage has no plan limits is probed with its economy model and its own home', async (t) => {
  const dir = tempDir('quota-row-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = fakeClaudeHome(join(dir, 'claude-home'), { accountUuid: 'claude-account' })
  const now = Date.parse('2026-11-14T12:00:00.000Z')
  const event = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: (now + 3_600_000) / 1000 } }
  const fake = fakeQuotaCli(join(dir, 'claude-cli'), { kind: 'claude', version: '2.1.322', answer: { rate_limits_available: false }, events: [event] })
  const spec: AccountConfig = { ref: 'claude-code/c1', runtime: 'claude-code', capabilities: ['research'], command: fake.command, claudeHome: home, models: { economy: 'cheap-model' } }
  const row = await mount(dir, [spec], () => now)
  assert.deepEqual(await row.quota(spec.ref), { observedAt: new Date(now).toISOString(), windows: { five_hour: { percentUsed: 90, resetsAt: new Date(now + 3_600_000).toISOString() } }, source: 'rate_limit_event' })
  const probe = fake.readLog().find((entry) => Array.isArray(entry.argv) && entry.argv[0] === '-p' && entry.home !== undefined && !entry.argv.includes('--input-format'))!
  assert.equal(probe.home, home)
  assert.equal((probe.argv as string[])[(probe.argv as string[]).indexOf('--model') + 1], 'cheap-model')
})
