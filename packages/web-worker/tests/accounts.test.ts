/**
 * WW6e: an operation on a web account waits, bounded, for that account's registration in progress (the Host reports
 * "started" before the `agents` row has handed every account over), and is refused with the registration's own
 * reason when it failed. No browser: the registrations here are held open by hand.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.ts'

/** Mount the row on a bare context; its service. */
function mount(config?: { registerWaitSeconds?: number }) {
  const provided: Record<string, any> = {}
  const services: Record<string, unknown> = { capabilities: {}, artifacts: {}, subprocess: {}, dsh: { home: '/nonexistent' } }
  const ctx = { get: (key: string) => services[key], effect: () => {}, provide: (key: string, value: unknown) => { provided[key] = value } }
  apply(ctx as never, config as never)
  return provided.webWorker as { expect(ref: string, done: Promise<unknown>): void; loginWait(ref: string, cancel: boolean): Promise<unknown>; loginRemote(ref: string): Promise<unknown> }
}

test('an account that is not configured is refused at once', { timeout: 10_000 }, async () => {
  const web = mount()
  await assert.rejects(web.loginRemote('chatgpt-web/none'), /chatgpt-web\/none is not a configured chatgpt-web account/)
})

test('an operation waits for the registration in progress, and a failed one is refused with its own reason', { timeout: 10_000 }, async () => {
  const web = mount()
  let fail!: (error: Error) => void
  web.expect('chatgpt-web/default', new Promise((_, reject) => { fail = reject }))
  let settled = false
  const asked = web.loginRemote('chatgpt-web/default').finally(() => { settled = true })
  asked.catch(() => {})
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(settled, false, 'it is still waiting for the registration')
  fail(new Error('Xvfb is not installed'))
  await assert.rejects(asked, /chatgpt-web\/default: Xvfb is not installed/)
})

test('the wait is bounded by registerWaitSeconds', { timeout: 10_000 }, async () => {
  const web = mount({ registerWaitSeconds: 0.2 })
  web.expect('chatgpt-web/default', new Promise(() => {}))
  await assert.rejects(web.loginRemote('chatgpt-web/default'), /chatgpt-web\/default is still registering after 0\.2 s/)
})
