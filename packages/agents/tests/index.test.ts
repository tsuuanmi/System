/**
 * The `agents` row's seam to the optional web Runtime (WW2a): a `web`
 * account is reported unavailable when the `web-worker` row is off, and
 * handed to its service, with the offered capabilities, when it is on.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { fakeQuotaCli } from '../../../test-support/quota.ts'
import { TASK_KIND, taskSchema, type WorkerPort } from '@system/work'
import { test } from 'node:test'
import { fakeClaudeHome, fakeCodexHome, tempDir } from '../../../test-support/accounts.ts'
import { REGISTERING, WEB_WORKER_DISABLED, apply, type WebRegistration } from '../src/index.ts'
import { RUNTIME_ABILITIES } from '../src/runtimes.ts'

/** Mount the row on a bare context with `webWorker` (if any); the accounts it reports and what it disposed. */
async function mount(webWorker: unknown, hold = false, accounts: object[] = [{}], services_: Record<string, unknown> = {}, rowSlots = 2): Promise<any> {
  const provided: Record<string, any> = {}
  const effects: (() => () => void)[] = []
  const services: Record<string, unknown> = { storageDomain: { open: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }) }, capabilities: {}, artifacts: {}, subprocess: {}, credentials: {}, webWorker, ...services_ }
  const ctx = { get: (key: string) => services[key], effect: (fn: () => () => void) => { effects.push(fn) }, provide: (key: string, value: unknown) => { provided[key] = value } }
  const started = apply(ctx as never, { maxConcurrentAttempts: rowSlots, accounts: accounts.map((own) => ({ ref: 'web/chatgpt/default', runtime: 'web', site: 'chatgpt', capabilities: ['research'], models: { standard: 'x' }, url: 'http://localhost/', ...own })) })
  if (hold) return { before: await provided.agents.accounts() as { available: boolean; reason: string }[], started }
  await started
  return { accounts: await provided.agents.accounts() as { ref: string; available: boolean; reason: string; command?: string; version?: string; capabilities: string[] }[], unload: () => effects.forEach((fn) => fn()()) }
}

test('with the web-worker row off, a web account is unavailable and the reason names the row', async () => {
  const { accounts } = await mount(undefined)
  assert.equal(accounts[0]!.available, false)
  assert.equal(accounts[0]!.reason, WEB_WORKER_DISABLED)
  assert.equal(WEB_WORKER_DISABLED, 'the web-worker row is disabled')
})

test('with the row on, the account goes to its service with its offered capabilities and one slot, and is released with the row', async () => {
  const registered: WebRegistration[] = []
  let disposed = 0
  const { accounts, unload } = await mount({ expect: () => {}, announced: () => {}, register: async (account: WebRegistration) => { registered.push(account); return { command: '/chrome', version: async () => '155', dispose: () => { disposed += 1 }, unavailable: () => undefined } } })
  assert.equal(accounts[0]!.available, true)
  assert.deepEqual([accounts[0]!.command, accounts[0]!.version, accounts[0]!.capabilities], ['/chrome', '155', ['research', 'tier.standard']])
  assert.deepEqual([registered[0]!.capabilities, registered[0]!.maxConcurrentAttempts, registered[0]!.url], [['research', 'tier.standard'], 1, 'http://localhost/'])
  unload()
  assert.equal(disposed, 1)
})

test('the capabilities the web-worker row reports (the tiers its Site map binds) are the account\'s', async () => {
  const offered = ['research', 'tier.economy', 'tier.standard', 'tier.frontier']
  const { accounts } = await mount({ expect: () => {}, announced: () => {}, register: async () => ({ command: '/chrome', version: async () => '155', capabilities: offered, dispose: () => {}, unavailable: () => undefined }) })
  assert.deepEqual(accounts[0]!.capabilities, offered)
})

test('an account reports the model of each tier it configures, in tier order, from the first moment', async () => {
  const { before } = await mount(undefined, true, [{ models: { frontier: 'f', economy: 'e' } }, { models: undefined }])
  assert.deepEqual((before as any[]).map((a) => a.models), [{ economy: 'e', frontier: 'f' }, {}])
})

test('an account the web-worker row says is not ready is unavailable with its reason, until it is ready again', async () => {
  let reason: string | undefined = 'needs sign-in since 05:10: run `system workers login web/chatgpt/default --remote`, then `system workers recheck web/chatgpt/default`'
  const web = { expect: () => {}, announced: () => {}, register: async () => ({ command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => reason }) }
  const first = await mount(web)
  assert.deepEqual([first.accounts[0]!.available, first.accounts[0]!.reason, first.accounts[0]!.version], [false, reason, '155'])
  reason = undefined
  const second = await mount(web)
  assert.deepEqual([second.accounts[0]!.available, second.accounts[0]!.reason], [true, 'registered'])
})

test('a service that refuses the account gives its reason', async () => {
  const { accounts } = await mount({ expect: () => {}, announced: () => {}, register: async () => { throw new Error('Xvfb is not installed') } })
  assert.deepEqual([accounts[0]!.available, accounts[0]!.reason], [false, 'Xvfb is not installed'])
})

test('an account whose registration is not done is listed as registering, and announced to the service until it is', async () => {
  const announced: Promise<unknown>[] = []
  let release!: () => void
  const { before, started } = await mount({ expect: (_ref: string, done: Promise<unknown>) => { announced.push(done) }, announced: () => {}, register: () => new Promise((resolve) => { release = () => resolve({ command: '/chrome', version: async () => '155', dispose: () => {} }) }) }, true)
  assert.deepEqual([before[0]!.available, before[0]!.reason], [false, REGISTERING])
  let done = false
  void announced[0]!.then(() => { done = true })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(done, false)
  release()
  await started
  await announced[0]
})

// flaky-2: an announced account whose registration the row never reached (its apply threw, or it was unloaded first) must be refused, not left pending until the operation's wait runs out.
test('an announced account is refused, not left pending, when the row stops before it registers the account', async () => {
  const announced: Promise<unknown>[] = []
  const web = { expect: (_ref: string, done: Promise<unknown>) => { announced.push(done) }, announced: () => {}, register: async () => ({ command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => undefined }) }
  await assert.rejects(mount(web, false, [{}], { storageDomain: { open: async () => { throw new Error('database is locked') } } }), /database is locked/)
  assert.equal(announced.length, 1)
  await assert.rejects(Promise.race([announced[0], new Promise((r) => setTimeout(() => r('still pending'), 200))]), /database is locked/)
})

const ONE_CHROME = 'a web account runs one attempt at a time (one Chrome profile); maxConcurrentAttempts must be 1'

test('a web account has one slot whatever the row says, and an agent CLI account inherits the row', async () => {
  const registered: WebRegistration[] = []
  const web = { expect: () => {}, announced: () => {}, register: async (account: WebRegistration) => { registered.push(account); return { command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => undefined } } }
  const resolved: unknown[] = []
  const subprocess = { resolveExecutable: async (name: string) => `/bin/${name}` }
  const credentials = { describe: async () => ({ configured: true }), resolve: async () => ({ value: 't' }) }
  const capabilities = { registerWorker: (worker: { maxConcurrentAttempts?: number }) => { resolved.push(worker.maxConcurrentAttempts); return () => {} } }
  const { accounts } = await mount(web, false, [{}, { ref: 'claude-code/default', runtime: 'claude-code', capabilities: ['research'], models: undefined, url: undefined }], { subprocess, credentials, capabilities }, 4)
  assert.deepEqual([accounts[0]!.available, registered[0]!.maxConcurrentAttempts], [true, 1])
  assert.equal(accounts[1]!.available, true, accounts[1]!.reason)
  assert.deepEqual(resolved, [4])
})

test('a web account that sets its own maxConcurrentAttempts other than 1 is unavailable', async () => {
  const web = { expect: () => {}, announced: () => {}, register: async () => ({ command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => undefined }) }
  const { accounts } = await mount(web, false, [{ maxConcurrentAttempts: 2 }, { ref: 'web/chatgpt/two', maxConcurrentAttempts: 1 }])
  assert.deepEqual([accounts[0]!.available, accounts[0]!.reason], [false, ONE_CHROME])
  assert.deepEqual([accounts[1]!.ref, accounts[1]!.available], ['web/chatgpt/two', true])
})

// WW-rename: the runtime is `web` with a `site`, and the ref says the same.
const SERVICE = { expect: () => {}, announced: () => {}, register: async () => ({ command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => undefined }) }

test('a web account whose ref is not web/<site>/<name> with its own site is unavailable', async () => {
  const { accounts } = await mount(SERVICE, false, [{ ref: 'web/gemini/default' }, { ref: 'web/default' }, { site: undefined }, { ref: 'web/chatgpt/second' }])
  assert.deepEqual(accounts.map((a: { available: boolean }) => a.available), [false, false, false, true])
  assert.equal(accounts[0]!.reason, 'the ref web/gemini/default does not match site chatgpt: a web account is web/<site>/<name>, here web/chatgpt/<name>')
  assert.match(accounts[1]!.reason, /web\/default does not match site chatgpt/)
  assert.equal(accounts[2]!.reason, 'a web account names its site (site: chatgpt)', 'a site is required')
})

// Account identity (sc-1): CLI accounts over fake homes.
const cliMount = async (accounts: object[], hold = false): Promise<{ registered: string[]; accounts: any[]; before: any[]; started: Promise<void> }> => {
  const registered: string[] = []
  const provided: Record<string, any> = {}
  const services = {
    storageDomain: { open: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }) },
    capabilities: { registerWorker: (w: { ref: string }) => { registered.push(w.ref); return () => {} } },
    artifacts: {}, credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'TOKEN-VALUE' }) },
    subprocess: { resolveExecutable: async (c: string) => c, spawn: () => ({ done: Promise.resolve({}), collected: {} }) },
  } as Record<string, unknown>
  const ctx = { get: (key: string) => services[key], effect: () => {}, provide: (key: string, value: unknown) => { provided[key] = value }, baseDir: tempDir('base-') }
  const started = apply(ctx as never, { accounts: accounts as never })
  const before = await provided.agents.accounts() as any[]
  if (hold) return { registered, before, accounts: before, started }
  await started
  return { registered, before, accounts: await provided.agents.accounts() as any[], started }
}
const claude = (ref: string, own: object = {}) => ({ ref, runtime: 'claude-code', capabilities: ['repo.write'], ...own })
const codex = (ref: string, home: string, own: object = {}) => ({ ref, runtime: 'codex', capabilities: ['repo.write'], codexHome: home, ...own })

test('any priority registers and carries a note, including multiple old primaries', async () => {
  const { accounts, registered } = await cliMount(['primary', 'primary', 'secondary', 'anything'].map((priority, i) => claude(`claude-code/c${i}`, { priority, claudeHome: tempDir() })))
  assert.deepEqual(accounts.map((a) => a.available), [true, true, true, true])
  assert.deepEqual(registered, accounts.map((a) => a.ref))
  for (const account of accounts) {
    assert.match(account.note ?? '', /priority is ignored/)
    assert.equal(account.priority, undefined)
  }
})

test('a duplicate provider account is refused for the later account with the first ref in the reason', async () => {
  const one = fakeCodexHome(undefined, 'acct-1')
  const two = fakeCodexHome(undefined, 'acct-1')
  const { accounts, registered } = await cliMount([codex('codex/x1', one), codex('codex/x2', two)])
  assert.deepEqual([accounts[0].available, accounts[0].providerAccount], [true, 'acct-1'])
  assert.deepEqual([accounts[1].available, accounts[1].providerAccount], [false, 'acct-1'])
  assert.equal(accounts[1].reason, 'provider account acct-1 is already registered as codex/x1; two refs on one account would count its quota twice')
  assert.deepEqual(registered, ['codex/x1'])
  const swapped = await cliMount([codex('codex/x2', two), codex('codex/x1', one)])
  assert.deepEqual(swapped.accounts.map((a) => a.available), [true, false])
})

test('two Claude accounts on one accountUuid, or one emailAddress, collide; another Runtime with that ID does not', async () => {
  for (const id of [{ accountUuid: 'u-1' }, { emailAddress: 'me@example.com' }]) {
    const { accounts } = await cliMount([claude('claude-code/c1', { claudeHome: fakeClaudeHome(undefined, id) }), claude('claude-code/c2', { claudeHome: fakeClaudeHome(undefined, id) })])
    assert.deepEqual(accounts.map((a) => a.available), [true, false])
  }
  const { accounts } = await cliMount([claude('claude-code/c1', { claudeHome: fakeClaudeHome(undefined, { accountUuid: 'same' }) }), codex('codex/x1', fakeCodexHome(undefined, 'same'))])
  assert.deepEqual(accounts.map((a) => a.available), [true, true])
})

test('an unreadable ID leaves the account registered with the ID unknown', async () => {
  const { accounts, registered } = await cliMount([codex('codex/x1', fakeCodexHome(undefined)), codex('codex/x2', fakeCodexHome(undefined)), claude('claude-code/c1', { claudeHome: tempDir() }), claude('claude-code/c2', { claudeHome: tempDir() })])
  assert.deepEqual(accounts.map((a) => [a.available, a.reason, a.providerAccount]), Array(4).fill([true, 'registered', undefined]))
  assert.equal(registered.length, 4)
})

test('the listing shows label, ignored-priority note and provider account from the first moment, and no secret', async () => {
  const specs = [claude('claude-code/c1', { label: 'me@example.com', priority: 'primary', claudeHome: fakeClaudeHome(undefined, { accountUuid: 'u-1' }) }), codex('codex/x1', fakeCodexHome(undefined, 'acct-1'))]
  const { before, started } = await cliMount(specs, true)
  assert.deepEqual(before.map((a) => [a.label, a.note]), [['me@example.com', 'priority is ignored: routing goes by quota headroom'], [undefined, undefined]])
  await started
  const { accounts } = await cliMount(specs)
  assert.deepEqual(accounts.map((a) => [a.label, a.note, a.providerAccount]), [['me@example.com', 'priority is ignored: routing goes by quota headroom', 'u-1'], [undefined, undefined, 'acct-1']])
  assert.doesNotMatch(JSON.stringify(accounts), /SECRET-|TOKEN-VALUE/)
})

test('a ref without a rename stays valid, and a web account has no provider account', async () => {
  const { accounts } = await cliMount([claude('claude-code/default')])
  assert.deepEqual([accounts[0].available, accounts[0].priority], [true, undefined])
  const web = await mount({ expect: () => {}, announced: () => {}, register: async () => ({ command: '/chrome', version: async () => '1', dispose: () => {}, unavailable: () => undefined }) }, false, [{ label: 'w', priority: 'primary' }])
  assert.deepEqual([web.accounts[0]!.available, web.accounts[0]!.providerAccount, web.accounts[0]!.note], [true, undefined, 'priority is ignored: routing goes by quota headroom'])
})

test('a Claude account reads the last rate_limit_event after the Host restarts', async (t) => {
  const dir = tempDir('agents-restart-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = fakeQuotaCli(join(dir, 'cli'), { kind: 'claude', version: '2.1.322', answer: { rate_limits_available: false, rate_limits: {} } })
  const rows = new Map<string, unknown>()
  const storageDomain = { open: async () => ({ table: () => ({
    get: (key: string) => structuredClone(rows.get(key)),
    put: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)) },
  }), close: async () => {} }) }
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema })
  const task = await artifacts.put({ ...TASK_KIND, content: { instructions: 'observe quota' }, classification: 'local-private', producer: { type: 'operator', ref: 'test' } })
  const stream = [
    { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: .77, status: 'allowed' } },
    { type: 'result', subtype: 'success', result: 'done', is_error: false },
  ].map((event) => JSON.stringify(event)).join('\n')
  const mountAgain = async () => {
    let worker!: WorkerPort
    let agents: any
    const effects: (() => () => void)[] = []
    const services: Record<string, unknown> = {
      storageDomain, artifacts, dshHomePath: (...parts: string[]) => join(dir, ...parts),
      credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'token' }) },
      capabilities: { registerWorker: (port: WorkerPort) => { worker = port; return () => {} } },
      subprocess: { resolveExecutable: async () => fake.command, spawn: (spec: { argv: string[] }) => ({
        done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit: async () => true,
        collected: { stdout: { readFrom: () => ({ text: spec.argv.includes('--version') ? '2.1.322 (Claude Code)' : stream }) } },
      }) },
    }
    await apply({ get: (key: string) => services[key], provide: (_key: string, value: unknown) => { agents = value }, effect: (fn: () => () => void) => { effects.push(fn) } } as never,
      { accounts: [claude('claude-code/restart', { command: fake.command, claudeHome: join(dir, 'home') })] } as never)
    return { worker, agents, unload: () => effects.forEach((fn) => fn()()) }
  }
  const first = await mountAgain()
  const result = await first.worker.run({ workId: 'work:restart', attemptId: 'attempt:restart', stepId: 'task', capabilities: ['research'], inputs: { task: task.id }, outputs: [], signal: new AbortController().signal })
  assert.equal(result.status, 'succeeded', result.reason)
  const before = await first.agents.quota('claude-code/restart')
  assert.equal(before.source, 'rate_limit_event', JSON.stringify(before))
  assert.equal(before.windows.seven_day.percentUsed, 77)
  await new Promise<void>((resolve) => setImmediate(resolve))
  first.unload()
  const second = await mountAgain()
  t.after(second.unload)
  const after = await second.agents.quota('claude-code/restart')
  assert.deepEqual(after, before)
})

test('a Claude account reads the last rate_limit_event even when the CLI version is not verified', async (t) => {
  const dir = tempDir('agents-restart-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = fakeQuotaCli(join(dir, 'cli'), { kind: 'claude', version: '2.1.325', answer: { rate_limits_available: false, rate_limits: {} } })
  const rows = new Map<string, unknown>()
  const storageDomain = { open: async () => ({ table: () => ({
    get: (key: string) => structuredClone(rows.get(key)),
    put: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)) },
  }), close: async () => {} }) }
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema })
  const task = await artifacts.put({ ...TASK_KIND, content: { instructions: 'observe quota' }, classification: 'local-private', producer: { type: 'operator', ref: 'test' } })
  const stream = [
    { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: .77, status: 'allowed' } },
    { type: 'result', subtype: 'success', result: 'done', is_error: false },
  ].map((event) => JSON.stringify(event)).join('\n')
  const mountAgain = async () => {
    let worker!: WorkerPort
    let agents: any
    const effects: (() => () => void)[] = []
    const services: Record<string, unknown> = {
      storageDomain, artifacts, dshHomePath: (...parts: string[]) => join(dir, ...parts),
      credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'token' }) },
      capabilities: { registerWorker: (port: WorkerPort) => { worker = port; return () => {} } },
      subprocess: { resolveExecutable: async () => fake.command, spawn: (spec: { argv: string[] }) => ({
        done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit: async () => true,
        collected: { stdout: { readFrom: () => ({ text: spec.argv.includes('--version') ? '2.1.325 (Claude Code)' : stream }) } },
      }) },
    }
    await apply({ get: (key: string) => services[key], provide: (_key: string, value: unknown) => { agents = value }, effect: (fn: () => () => void) => { effects.push(fn) } } as never,
      { accounts: [claude('claude-code/newer', { command: fake.command, claudeHome: join(dir, 'home') })] } as never)
    return { worker, agents, unload: () => effects.forEach((fn) => fn()()) }
  }
  const first = await mountAgain()
  const result = await first.worker.run({ workId: 'work:newer', attemptId: 'attempt:newer', stepId: 'task', capabilities: ['research'], inputs: { task: task.id }, outputs: [], signal: new AbortController().signal })
  assert.equal(result.status, 'succeeded', result.reason)
  const before = await first.agents.quota('claude-code/newer')
  assert.equal(before.source, 'rate_limit_event', JSON.stringify(before))
  assert.equal(before.windows.seven_day.percentUsed, 77)
  assert.equal(before.unreadable, undefined)
  first.unload()
})

// nm-1: abilities come from the Runtime's adapter in code, not from the profile.
test('each Runtime declares its abilities: Claude Code repo.read, repo.write, web.search; Codex repo.read, repo.write; web web.search, web.browse', () => {
  assert.deepEqual(RUNTIME_ABILITIES['claude-code'], ['repo.read', 'repo.write', 'web.search'])
  assert.deepEqual(RUNTIME_ABILITIES.codex, ['repo.read', 'repo.write'])
  assert.deepEqual(RUNTIME_ABILITIES.web, ['web.search', 'web.browse'])
})

test('a CLI Account registers with its Runtime abilities and what its profile grants; status lists them apart', async () => {
  const ports: WorkerPort[] = []
  const provided: Record<string, any> = {}
  const services = {
    storageDomain: { open: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }) },
    capabilities: { registerWorker: (w: WorkerPort) => { ports.push(w); return () => {} } },
    artifacts: {}, credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'TOKEN-VALUE' }) },
    subprocess: { resolveExecutable: async (c: string) => c, spawn: () => ({ done: Promise.resolve({}), collected: {} }) },
  } as Record<string, unknown>
  const ctx = { get: (key: string) => services[key], effect: () => {}, provide: (key: string, value: unknown) => { provided[key] = value }, baseDir: tempDir('base-') }
  await apply(ctx as never, { accounts: [
    claude('claude-code/a', { claudeHome: tempDir(), capabilities: ['develop.implement', 'research'], models: { standard: 'm' } }),
    codex('codex/b', fakeCodexHome(undefined, 'acct-b'), { capabilities: ['research'] }),
  ] as never })
  const [a, b] = ports
  for (const need of ['repo.read', 'repo.write', 'web.search', 'develop.implement', 'research', 'tier.standard']) assert.ok(a!.capabilities.includes(need), `claude ${need}`)
  assert.ok(b!.capabilities.includes('repo.write') && b!.capabilities.includes('research'))
  assert.ok(!b!.capabilities.includes('web.search'), 'codex has no web.search')
  const status = await provided.agents.accounts() as { ref: string; abilities: string[]; capabilities: string[] }[]
  assert.deepEqual(status.map((s) => [s.ref, s.abilities, s.capabilities]), [
    ['claude-code/a', ['repo.read', 'repo.write', 'web.search'], ['develop.implement', 'research', 'tier.standard']],
    ['codex/b', ['repo.read', 'repo.write'], ['research']],
  ])
})

test('a web Account is handed over with the web abilities, and its status lists them apart from its granted capabilities', async () => {
  const registered: WebRegistration[] = []
  const { accounts } = await mount({ expect: () => {}, announced: () => {}, register: async (account: WebRegistration) => { registered.push(account); return { command: '/chrome', version: async () => '1', dispose: () => {}, unavailable: () => undefined } } })
  assert.deepEqual(registered[0]!.abilities, ['web.search', 'web.browse'])
  assert.deepEqual((accounts[0] as any).abilities, ['web.search', 'web.browse'])
  assert.deepEqual(accounts[0]!.capabilities, ['research', 'tier.standard'])
})

// flaky-2 (third occurrence): Cordis applies the rows that were waiting for the same services in no fixed order, so the agents row can apply
// before the web-worker row has provided `webWorker`. It then reported its web accounts as "the web-worker row is disabled" and never announced
// them, and the web-worker row waited 60 s for an announcement that was never coming ("still registering after 60 s").
/** A bare context whose registry lists the web-worker row, which provides its service only when the test says (`provide`). */
function mountBeforeWebWorker(waitSeconds?: number) {
  const provided: Record<string, any> = {}
  let appeared: ((ctx: { get(key: string): unknown }) => void) | undefined
  const services: Record<string, unknown> = { storageDomain: { open: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }) }, capabilities: {}, artifacts: {}, subprocess: {}, credentials: {} }
  const ctx = {
    get: (key: string) => services[key],
    registry: { values: () => [{ name: 'system-web-worker' }] },
    inject: (_names: string[], callback: (ctx: { get(key: string): unknown }) => void) => { appeared = callback },
    effect: () => {},
    provide: (key: string, value: unknown) => { provided[key] = value },
  }
  const started = apply(ctx as never, { webWorkerWaitSeconds: waitSeconds, accounts: [{ ref: 'web/chatgpt/default', runtime: 'web', site: 'chatgpt', capabilities: ['research'], url: 'http://localhost/' }] } as never)
  return {
    started,
    accounts: () => provided.agents.accounts() as Promise<{ available: boolean; reason: string }[]>,
    provide: (service: unknown) => { services.webWorker = service; appeared!(ctx) },
  }
}

test('a web-worker row that provides its service after the agents row applied is still handed the accounts and told they are announced', async () => {
  const calls: string[] = []
  const row = mountBeforeWebWorker()
  assert.deepEqual((await row.accounts()).map((a) => a.reason), [REGISTERING], 'the account is listed as registering while the row is awaited')
  row.provide({ expect: (ref: string) => { calls.push(`expect ${ref}`) }, announced: () => { calls.push('announced') }, register: async (account: WebRegistration) => { calls.push(`register ${account.ref}`); return { command: '/chrome', version: async () => '1', dispose: () => {}, unavailable: () => undefined } } })
  await row.started
  assert.deepEqual(calls, ['expect web/chatgpt/default', 'announced', 'register web/chatgpt/default'])
  assert.deepEqual((await row.accounts()).map((a) => [a.available, a.reason]), [[true, 'registered']])
})

test('a web-worker row that never provides its service is waited for, bounded by webWorkerWaitSeconds, and the account says so', async () => {
  const row = mountBeforeWebWorker(0.05)
  await row.started
  const [account] = await row.accounts()
  assert.equal(account!.available, false)
  assert.match(account!.reason, /web-worker row did not start within 0\.05 s/)
})

test('the sandbox option on a web account is refused with the reason, a shape of sb-1 too', async () => {
  const { accounts } = await mount(undefined, false, [{ sandbox: true }])
  assert.equal(accounts[0]!.available, false)
  assert.match(accounts[0]!.reason, /a web account has none/)
  const old = await mount(undefined, false, [{ runtime: 'claude-code', ref: 'claude-code/x', sandbox: { allowRead: ['/x'] } }])
  assert.match(old.accounts[0]!.reason, /sandbox must be true/)
})
