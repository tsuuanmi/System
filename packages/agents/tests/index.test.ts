/**
 * The `agents` row's seam to the optional web Runtime (WW2a): a `web`
 * account is reported unavailable when the `web-worker` row is off, and
 * handed to its service, with the offered capabilities, when it is on.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeClaudeHome, fakeCodexHome, tempDir } from '../../../test-support/accounts.ts'
import { REGISTERING, WEB_WORKER_DISABLED, apply, type WebRegistration } from '../src/index.ts'

/** Mount the row on a bare context with `webWorker` (if any); the accounts it reports and what it disposed. */
async function mount(webWorker: unknown, hold = false, accounts: object[] = [{}], services_: Record<string, unknown> = {}, rowSlots = 2): Promise<any> {
  const provided: Record<string, any> = {}
  const effects: (() => () => void)[] = []
  const services: Record<string, unknown> = { capabilities: {}, artifacts: {}, subprocess: {}, credentials: {}, webWorker, ...services_ }
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
  const { accounts, unload } = await mount({ expect: () => {}, register: async (account: WebRegistration) => { registered.push(account); return { command: '/chrome', version: async () => '155', dispose: () => { disposed += 1 }, unavailable: () => undefined } } })
  assert.equal(accounts[0]!.available, true)
  assert.deepEqual([accounts[0]!.command, accounts[0]!.version, accounts[0]!.capabilities], ['/chrome', '155', ['research', 'tier.standard']])
  assert.deepEqual([registered[0]!.capabilities, registered[0]!.maxConcurrentAttempts, registered[0]!.url], [['research', 'tier.standard'], 1, 'http://localhost/'])
  unload()
  assert.equal(disposed, 1)
})

test('the capabilities the web-worker row reports (the tiers its Site map binds) are the account\'s', async () => {
  const offered = ['research', 'tier.economy', 'tier.standard', 'tier.frontier']
  const { accounts } = await mount({ expect: () => {}, register: async () => ({ command: '/chrome', version: async () => '155', capabilities: offered, dispose: () => {}, unavailable: () => undefined }) })
  assert.deepEqual(accounts[0]!.capabilities, offered)
})

test('an account reports the model of each tier it configures, in tier order, from the first moment', async () => {
  const { before } = await mount(undefined, true, [{ models: { frontier: 'f', economy: 'e' } }, { models: undefined }])
  assert.deepEqual((before as any[]).map((a) => a.models), [{ economy: 'e', frontier: 'f' }, {}])
})

test('an account the web-worker row says is not ready is unavailable with its reason, until it is ready again', async () => {
  let reason: string | undefined = 'needs sign-in since 05:10: run `system workers login web/chatgpt/default --remote`, then `system workers recheck web/chatgpt/default`'
  const web = { expect: () => {}, register: async () => ({ command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => reason }) }
  const first = await mount(web)
  assert.deepEqual([first.accounts[0]!.available, first.accounts[0]!.reason, first.accounts[0]!.version], [false, reason, '155'])
  reason = undefined
  const second = await mount(web)
  assert.deepEqual([second.accounts[0]!.available, second.accounts[0]!.reason], [true, 'registered'])
})

test('a service that refuses the account gives its reason', async () => {
  const { accounts } = await mount({ expect: () => {}, register: async () => { throw new Error('Xvfb is not installed') } })
  assert.deepEqual([accounts[0]!.available, accounts[0]!.reason], [false, 'Xvfb is not installed'])
})

test('an account whose registration is not done is listed as registering, and announced to the service until it is', async () => {
  const announced: Promise<unknown>[] = []
  let release!: () => void
  const { before, started } = await mount({ expect: (_ref: string, done: Promise<unknown>) => { announced.push(done) }, register: () => new Promise((resolve) => { release = () => resolve({ command: '/chrome', version: async () => '155', dispose: () => {} }) }) }, true)
  assert.deepEqual([before[0]!.available, before[0]!.reason], [false, REGISTERING])
  let done = false
  void announced[0]!.then(() => { done = true })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(done, false)
  release()
  await started
  await announced[0]
})

const ONE_CHROME = 'a web account runs one attempt at a time (one Chrome profile); maxConcurrentAttempts must be 1'

test('a web account has one slot whatever the row says, and an agent CLI account inherits the row', async () => {
  const registered: WebRegistration[] = []
  const web = { expect: () => {}, register: async (account: WebRegistration) => { registered.push(account); return { command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => undefined } } }
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
  const web = { expect: () => {}, register: async () => ({ command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => undefined }) }
  const { accounts } = await mount(web, false, [{ maxConcurrentAttempts: 2 }, { ref: 'web/chatgpt/two', maxConcurrentAttempts: 1 }])
  assert.deepEqual([accounts[0]!.available, accounts[0]!.reason], [false, ONE_CHROME])
  assert.deepEqual([accounts[1]!.ref, accounts[1]!.available], ['web/chatgpt/two', true])
})

// WW-rename: the runtime is `web` with a `site`, and the ref says the same.
const SERVICE = { expect: () => {}, register: async () => ({ command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => undefined }) }

test('the chatgpt-web runtime is refused with the new names, even with the row on and off', async () => {
  const renamed = 'the chatgpt-web runtime was renamed: use runtime: web, site: chatgpt, ref web/chatgpt/<name>'
  for (const web of [SERVICE, undefined]) {
    const { accounts } = await mount(web, false, [{ ref: 'chatgpt-web/default', runtime: 'chatgpt-web', site: undefined }])
    assert.deepEqual([accounts[0]!.available, accounts[0]!.reason], [false, renamed])
  }
})

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
const claude = (ref: string, own: object = {}) => ({ ref, runtime: 'claude-code', capabilities: ['code-write'], ...own })
const codex = (ref: string, home: string, own: object = {}) => ({ ref, runtime: 'codex', capabilities: ['code-write'], codexHome: home, ...own })

test('a second primary of a Runtime is refused naming the first; one primary or none registers', async () => {
  const dir = tempDir()
  const { accounts, registered } = await cliMount([claude('claude-code/c1', { priority: 'primary', claudeHome: dir }), claude('claude-code/c2', { priority: 'primary', claudeHome: dir }), codex('codex/x1', fakeCodexHome(undefined, 'a'), { priority: 'primary' }), claude('claude-code/c3', { claudeHome: dir })])
  assert.deepEqual(accounts.map((a) => a.available), [true, false, true, true])
  assert.match(accounts[1].reason, /priority: primary is already held by claude-code\/c1/)
  assert.deepEqual(registered, ['claude-code/c1', 'codex/x1', 'claude-code/c3'])
})

test('a priority other than primary is refused', async () => {
  const { accounts } = await cliMount([claude('claude-code/c1', { priority: 'secondary' })])
  assert.equal(accounts[0].available, false)
  assert.match(accounts[0].reason, /priority must be primary or omitted/)
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

test('the listing shows label, priority and provider account from the first moment, and no secret', async () => {
  const specs = [claude('claude-code/c1', { label: 'me@example.com', priority: 'primary', claudeHome: fakeClaudeHome(undefined, { accountUuid: 'u-1' }) }), codex('codex/x1', fakeCodexHome(undefined, 'acct-1'))]
  const { before, started } = await cliMount(specs, true)
  assert.deepEqual(before.map((a) => [a.label, a.priority]), [['me@example.com', 'primary'], [undefined, 'secondary']])
  await started
  const { accounts } = await cliMount(specs)
  assert.deepEqual(accounts.map((a) => [a.label, a.priority, a.providerAccount]), [['me@example.com', 'primary', 'u-1'], [undefined, 'secondary', 'acct-1']])
  assert.doesNotMatch(JSON.stringify(accounts), /SECRET-|TOKEN-VALUE/)
})

test('a ref without a rename stays valid, and a web account has no provider account', async () => {
  const { accounts } = await cliMount([claude('claude-code/default')])
  assert.deepEqual([accounts[0].available, accounts[0].priority], [true, 'secondary'])
  const web = await mount({ expect: () => {}, register: async () => ({ command: '/chrome', version: async () => '1', dispose: () => {}, unavailable: () => undefined }) }, false, [{ label: 'w', priority: 'primary' }])
  assert.deepEqual([web.accounts[0]!.available, web.accounts[0]!.providerAccount, web.accounts[0]!.priority], [true, undefined, 'primary'])
})
