/**
 * WW6e: an operation on a web account waits, bounded, for that account's registration in progress (the Host reports
 * "started" before the `agents` row has handed every account over), and is refused with the registration's own
 * reason when it failed. No browser: the registrations here are held open by hand.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { shippedMap } from '@system/web-driver'
import { apply, offeredTiers } from '../src/index.ts'

/** Mount the row on a bare context; its service. */
function mount(config?: { registerWaitSeconds?: number }, home = '/nonexistent') {
  const provided: Record<string, any> = {}
  const services: Record<string, unknown> = { capabilities: {}, artifacts: {}, subprocess: {}, dshHomePath: (...segments: string[]) => join(home, ...segments) }
  const ctx = { get: (key: string) => services[key], effect: () => {}, provide: (key: string, value: unknown) => { provided[key] = value } }
  apply(ctx as never, config as never)
  return provided.webWorker as { register(account: Record<string, unknown>): Promise<unknown>; expect(ref: string, done: Promise<unknown>): void; loginWait(ref: string, cancel: boolean): Promise<unknown>; loginRemote(ref: string): Promise<unknown> }
}

test('an account that is not configured is refused at once', { timeout: 10_000 }, async () => {
  const web = mount()
  await assert.rejects(web.loginRemote('web/chatgpt/none'), /web\/chatgpt\/none is not a configured web account/)
})

test('an operation waits for the registration in progress, and a failed one is refused with its own reason', { timeout: 10_000 }, async () => {
  const web = mount()
  let fail!: (error: Error) => void
  web.expect('web/chatgpt/default', new Promise((_, reject) => { fail = reject }))
  let settled = false
  const asked = web.loginRemote('web/chatgpt/default').finally(() => { settled = true })
  asked.catch(() => {})
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(settled, false, 'it is still waiting for the registration')
  fail(new Error('Xvfb is not installed'))
  await assert.rejects(asked, /web\/chatgpt\/default: Xvfb is not installed/)
})

test('the wait is bounded by registerWaitSeconds', { timeout: 10_000 }, async () => {
  const web = mount({ registerWaitSeconds: 0.2 })
  web.expect('web/chatgpt/default', new Promise(() => {}))
  await assert.rejects(web.loginRemote('web/chatgpt/default'), /web\/chatgpt\/default is still registering after 0\.2 s/)
})

test('an account whose registration failed before the operation came is refused with that reason, not as "not configured"', { timeout: 10_000 }, async () => {
  const web = mount()
  const failed = Promise.reject(new Error('the configured Chrome path does not exist: /gone'))
  web.expect('web/chatgpt/default', failed)
  await failed.catch(() => {})
  await new Promise((r) => setTimeout(r, 50))
  await assert.rejects(web.loginRemote('web/chatgpt/default'), /web\/chatgpt\/default: the configured Chrome path does not exist: \/gone/)
})

// WW2-iv: the legacy driver is gone, and the option that chose between it and the generic Procedures with it. It is refused before any browser is looked for.
test('an account that still sets procedures, either value, is refused with the reason', { timeout: 10_000 }, async () => {
  const web = mount()
  for (const value of ['legacy', 'generic', undefined, 'Generic']) {
    await assert.rejects(web.register({ ref: 'web/chatgpt/default', capabilities: [], site: 'chatgpt', procedures: value }), /procedures was removed: the generic Procedures are the only path; delete the line/)
  }
})

// WW8b: an Account offers the tiers when its Site map binds a Power control and the generic Procedures run it, as a CLI Account offers them from `models`.
test('a web account offers the three tiers when the map binds Power', () => {
  const map = shippedMap()
  assert.deepEqual(offeredTiers(map), ['tier.economy', 'tier.standard', 'tier.frontier'])
  assert.deepEqual(offeredTiers({ ...map, actions: { ...map.actions, 'model.close': undefined as never } }), [], 'a map without the control')
  const { 'model.power': _, ...elements } = map.elements
  assert.deepEqual(offeredTiers({ ...map, elements }), [])
})

// WW-rename: the Site picks the shipped map and the defaults; an unknown one is refused with the shipped Sites.
test('an unknown site is refused with the list of shipped sites', { timeout: 10_000 }, async () => {
  const web = mount()
  await assert.rejects(web.register({ ref: 'web/gemini/default', site: 'gemini', capabilities: [] }), /unknown site gemini; the shipped sites are: chatgpt/)
})

const home = mkdtempSync(join(tmpdir(), 'system-accounts-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('registering moves the old account directory once, and refuses to when both exist, naming both', { timeout: 20_000 }, async () => {
  const web = mount(undefined, home)
  const old = join(home, 'system', 'chatgpt-web', 'default')
  const current = join(home, 'system', 'web', 'chatgpt', 'default')
  mkdirSync(old, { recursive: true })
  // It may be refused later for want of Xvfb or Chrome; the move came before.
  await web.register({ ref: 'web/chatgpt/default', site: 'chatgpt', capabilities: [] }).catch(() => {})
  assert.deepEqual([existsSync(old), existsSync(current)], [false, true])
  mkdirSync(old, { recursive: true })
  await assert.rejects(web.register({ ref: 'web/chatgpt/default', site: 'chatgpt', capabilities: [] }), (error: Error) => error.message.includes(old) && error.message.includes(current))
  assert.equal(existsSync(old), true, 'nothing was deleted')
})
