/**
 * The `agents` row's seam to the optional web Runtime (WW2a): a `web`
 * account is reported unavailable when the `web-worker` row is off, and
 * handed to its service, with the offered capabilities, when it is on.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
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
