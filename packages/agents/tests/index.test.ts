/**
 * The `agents` row's seam to the optional web Runtime (WW2a): a `chatgpt-web`
 * account is reported unavailable when the `web-worker` row is off, and
 * handed to its service, with the offered capabilities, when it is on.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WEB_WORKER_DISABLED, apply, type WebRegistration } from '../src/index.ts'

/** Mount the row on a bare context with `webWorker` (if any); the accounts it reports and what it disposed. */
async function mount(webWorker: unknown) {
  const provided: Record<string, any> = {}
  const effects: (() => () => void)[] = []
  const services: Record<string, unknown> = { capabilities: {}, artifacts: {}, subprocess: {}, credentials: {}, webWorker }
  const ctx = { get: (key: string) => services[key], effect: (fn: () => () => void) => { effects.push(fn) }, provide: (key: string, value: unknown) => { provided[key] = value } }
  await apply(ctx as never, { maxConcurrentAttempts: 2, accounts: [{ ref: 'chatgpt-web/default', runtime: 'chatgpt-web', capabilities: ['research'], models: { standard: 'x' }, url: 'http://localhost/' }] })
  return { accounts: await provided.agents.accounts() as { available: boolean; reason: string; command?: string; version?: string; capabilities: string[] }[], unload: () => effects.forEach((fn) => fn()()) }
}

test('with the web-worker row off, a chatgpt-web account is unavailable and the reason names the row', async () => {
  const { accounts } = await mount(undefined)
  assert.equal(accounts[0]!.available, false)
  assert.equal(accounts[0]!.reason, WEB_WORKER_DISABLED)
  assert.equal(WEB_WORKER_DISABLED, 'the web-worker row is disabled')
})

test('with the row on, the account goes to its service with its offered capabilities and limits, and is released with the row', async () => {
  const registered: WebRegistration[] = []
  let disposed = 0
  const { accounts, unload } = await mount({ register: async (account: WebRegistration) => { registered.push(account); return { command: '/chrome', version: async () => '155', dispose: () => { disposed += 1 }, unavailable: () => undefined } } })
  assert.equal(accounts[0]!.available, true)
  assert.deepEqual([accounts[0]!.command, accounts[0]!.version, accounts[0]!.capabilities], ['/chrome', '155', ['research', 'tier.standard']])
  assert.deepEqual([registered[0]!.capabilities, registered[0]!.maxConcurrentAttempts, registered[0]!.url], [['research', 'tier.standard'], 2, 'http://localhost/'])
  unload()
  assert.equal(disposed, 1)
})

test('an account the web-worker row says is not ready is unavailable with its reason, until it is ready again', async () => {
  let reason: string | undefined = 'needs sign-in since 05:10: run `system workers login chatgpt-web/default --remote`, then `system workers recheck chatgpt-web/default`'
  const web = { register: async () => ({ command: '/chrome', version: async () => '155', dispose: () => {}, unavailable: () => reason }) }
  const first = await mount(web)
  assert.deepEqual([first.accounts[0]!.available, first.accounts[0]!.reason, first.accounts[0]!.version], [false, reason, '155'])
  reason = undefined
  const second = await mount(web)
  assert.deepEqual([second.accounts[0]!.available, second.accounts[0]!.reason], [true, 'registered'])
})

test('a service that refuses the account gives its reason', async () => {
  const { accounts } = await mount({ register: async () => { throw new Error('Xvfb is not installed') } })
  assert.deepEqual([accounts[0]!.available, accounts[0]!.reason], [false, 'Xvfb is not installed'])
})
