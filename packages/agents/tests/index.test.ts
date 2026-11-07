/**
 * The `agents` row's seam to the optional web Runtime (WW2a): a `chatgpt-web`
 * account is reported unavailable when the `web-worker` row is off, and
 * handed to its service, with the offered capabilities, when it is on.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REGISTERING, WEB_WORKER_DISABLED, apply, type WebRegistration } from '../src/index.ts'

/** Mount the row on a bare context with `webWorker` (if any); the accounts it reports and what it disposed. */
async function mount(webWorker: unknown, hold = false): Promise<any> {
  const provided: Record<string, any> = {}
  const effects: (() => () => void)[] = []
  const services: Record<string, unknown> = { capabilities: {}, artifacts: {}, subprocess: {}, credentials: {}, webWorker }
  const ctx = { get: (key: string) => services[key], effect: (fn: () => () => void) => { effects.push(fn) }, provide: (key: string, value: unknown) => { provided[key] = value } }
  const started = apply(ctx as never, { maxConcurrentAttempts: 2, accounts: [{ ref: 'chatgpt-web/default', runtime: 'chatgpt-web', capabilities: ['research'], models: { standard: 'x' }, url: 'http://localhost/' }] })
  if (hold) return { before: await provided.agents.accounts() as { available: boolean; reason: string }[], started }
  await started
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
  const { accounts, unload } = await mount({ expect: () => {}, register: async (account: WebRegistration) => { registered.push(account); return { command: '/chrome', version: async () => '155', dispose: () => { disposed += 1 } } } })
  assert.equal(accounts[0]!.available, true)
  assert.deepEqual([accounts[0]!.command, accounts[0]!.version, accounts[0]!.capabilities], ['/chrome', '155', ['research', 'tier.standard']])
  assert.deepEqual([registered[0]!.capabilities, registered[0]!.maxConcurrentAttempts, registered[0]!.url], [['research', 'tier.standard'], 2, 'http://localhost/'])
  unload()
  assert.equal(disposed, 1)
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
