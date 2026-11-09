/**
 * The ported driver against System 1's stand-in for chatgpt.com (fake-chatgpt.ts): what
 * the login and the recheck rely on (the sign-in states, a temporary chat opened in Chat mode
 * with the switch awaited, the page diagnostics). A turn is the Procedures' (conformance.test.ts)
 * and the Runtime's attempts are tested in packages/web-worker/tests/chatgpt.test.ts.
 * Headed Chrome on a private Xvfb; no network, no account.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { BrowserContext, Page } from 'patchright-core'
import { CHROME, skipHeaded } from '../../../test-support/headed.ts'
import { launch, webDefaults } from '../../web-worker/src/chatgpt.ts'
import { startXvfb, type Display } from '../../web-worker/src/display.ts'
import { ChatGptWebDriver, ProviderError, shippedMap, type DriverTimeouts } from '../src/index.ts'
import { FakeChatGpt, type FakeOptions } from './fake-chatgpt.ts'

const skip = skipHeaded
const root = mkdtempSync(join(tmpdir(), 'system-driver-'))
let display: Display
const opened: Array<() => Promise<unknown>> = []
before(async () => {
  if (!skip) display = await startXvfb()
})
after(async () => {
  for (const close of opened) await close()
  await display?.stop()
  rmSync(root, { recursive: true, force: true })
})

let count = 0
/** A fake site with `options`, a Chrome on a fresh profile, and a driver for the site; all closed after the file. */
async function start(options: FakeOptions = {}, timeouts: DriverTimeouts = {}): Promise<{ fake: FakeChatGpt; page: Page; driver: ChatGptWebDriver; context: BrowserContext }> {
  const fake = new FakeChatGpt({ thinkMs: 100, ...options })
  await fake.start()
  const context = await launch({ ...webDefaults(join(root, `profile-${count++}`)), executablePath: CHROME }, display)
  opened.push(() => context.close().catch(() => {}), () => fake.stop())
  const driver = new ChatGptWebDriver({ origin: fake.origin, timeouts: { readyMs: 8000, ...timeouts } })
  driver.healEnabled = () => false
  return { fake, page: context.pages()[0] ?? await context.newPage(), driver, context }
}


test('the shipped map loads and passes the schema', () => {
  const map = shippedMap()
  assert.equal(map.provider, 'chatgpt-web')
  assert.ok(map.elements['composer.input'])
  assert.ok(map.hash.startsWith('sha256:'))
})

test('checkAuth tells signed in, signed out and a challenge', { skip, timeout: 60_000 }, async () => {
  const signedIn = await start()
  assert.equal(await signedIn.driver.checkAuth(signedIn.page), 'signed-in')
  const signedOut = await start({ signedIn: false })
  assert.equal(await signedOut.driver.checkAuth(signedOut.page), 'signed-out')
  const challenged = await start({ captcha: true })
  await assert.rejects(challenged.driver.checkAuth(challenged.page), (error: unknown) => error instanceof ProviderError && error.kind === 'challenge')
})

const MODE_WAIT = { modeReadyMs: 1500, modeSettleMs: 300 }
const failure = (kind: string, message: RegExp) => (error: unknown) => error instanceof ProviderError && error.kind === kind && message.test(error.message)
const OPEN = { conversation: 'temporary' } as const
/** The mode the page shows as pressed. */
const pressed = (page: Page) => page.locator('#mode-chat').getAttribute('aria-pressed')

test('the shipped map bounds the wait for the mode switch', () => {
  const settings = shippedMap().settings
  assert.ok(settings.modeReadyMs >= 5000 && settings.modeReadyMs <= 60_000, JSON.stringify(settings))
  assert.ok(settings.modeSettleMs > 0)
})

test('a switch that appears late, after the composer, is waited for; the page is left in Chat', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ modeSwitchDelayMs: 1000 }, { ...MODE_WAIT, modeReadyMs: 8000 })
  await driver.open(page, OPEN)
  assert.equal(await pressed(page), 'true', 'the page started on Work: it was switched to Chat')
  assert.equal(fake.sent.length, 0)
})

test('a switch that never appears fails as an unknown mode at the deadline, with nothing sent', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ modeSwitch: false }, MODE_WAIT)
  const started = Date.now()
  await assert.rejects(driver.open(page, OPEN), failure('ui_drift', /mode unknown: the Chat\/Work switch did not appear within 1\.5 s/))
  assert.ok(Date.now() - started >= 1400, 'the wait was bounded by the setting, not skipped')
  assert.equal(fake.sent.length, 0)
})

test('a session that ends, or a challenge that appears, while the switch is awaited is named as such', { skip, timeout: 60_000 }, async () => {
  const out = await start({ modeSwitch: false, signOutAfterMs: 300 }, MODE_WAIT)
  await assert.rejects(out.driver.open(out.page, OPEN), failure('reauth_required', /signed out/))
  const challenged = await start({ modeSwitch: false, challengeAfterMs: 300 }, MODE_WAIT)
  await assert.rejects(challenged.driver.open(challenged.page, OPEN), failure('challenge', /challenge/))
})

test('a mode that changes while the switch is awaited is read again, and the page is left in Chat', { skip, timeout: 60_000 }, async () => {
  const { page, driver } = await start({ startOnWork: false, modeSwitchDelayMs: 200, modeFlipToWorkMs: 150 }, { ...MODE_WAIT, modeReadyMs: 8000 })
  await driver.open(page, OPEN)
  assert.equal(await pressed(page), 'true')
})

test('the diagnostics of a page are bounded and redacted: URL, viewport, map version, DOM without values or text of inputs', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ modeSwitch: false })
  await page.goto(`${fake.origin}/`)
  await page.evaluate(() => {
    const search = document.querySelector('input[type=search]') as HTMLInputElement
    search.setAttribute('value', 'SECRET-VALUE')
    search.value = 'SECRET-VALUE'
    document.querySelector('#input')!.textContent = 'SECRET-DRAFT'
    document.body.insertAdjacentHTML('beforeend', '<a href="/x?token=SECRET-TOKEN#frag">l</a><script>var SECRET_SCRIPT = 1</script>' + '<p>pad</p>'.repeat(5000))
  })
  const found = await driver.diagnostics(page)
  assert.match(found.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  assert.ok(found.viewport.width > 0 && found.viewport.height > 0)
  assert.deepEqual(found.uiMap, { revision: driver.map.uiRevision, hash: driver.map.hash })
  assert.ok(found.dom.length <= 20_000 && found.truncated)
  assert.doesNotMatch(JSON.stringify(found), /SECRET/)
  assert.match(found.dom, /Composer mode/, 'the structure is kept')
})

test('the diagnostics keep structure only: text nodes and attribute values are lengths, aria-labels and data-testid stay', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ modeSwitch: false })
  await page.goto(`${fake.origin}/`)
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<section data-testid="turn" data-secret-name="SECRET-DATA" title="SECRET-TITLE" id="SECRET-ID" class="SECRET-CLASS" role="log" aria-label="Chat log"><p>SECRET-TEXT me@example.com</p><a href="/x?t=SECRET-QUERY" data-user="SECRET-USER">SECRET-LINK</a></section>')
  })
  const found = await driver.diagnostics(page)
  assert.doesNotMatch(JSON.stringify(found), /SECRET|example\.com/)
  assert.match(found.dom, /data-testid="turn"/)
  assert.match(found.dom, /data-secret-name="\[text:11\]"/, 'data-* names stay, their values are lengths')
  assert.match(found.dom, /role="log"/)
  assert.match(found.dom, /aria-label="Chat log"/)
  assert.match(found.dom, /\[text:\d+\]/)
})

test('the mode wait ends at its deadline even when the mode would be stable only after it; nothing is sent', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({}, { modeReadyMs: 1000, modeSettleMs: 2500 })
  const started = Date.now()
  await assert.rejects(driver.open(page, OPEN), failure('ui_drift', /mode unknown/))
  assert.ok(Date.now() - started < 2400, `ended at the deadline, not after the settle (${Date.now() - started} ms)`)
  assert.equal(fake.sent.length, 0)
})

test('a mode that leaves Chat and comes back inside the settle interval restarts it', { skip, timeout: 60_000 }, async () => {
  const { page, driver } = await start({ startOnWork: false }, { modeReadyMs: 20_000, modeSettleMs: 2000 })
  const flips: number[] = []
  let opened = 0
  driver.onStage = ({ stage, status }) => {
    if (stage === 'auth' && status === 'ok') {
      const click = (id: string) => page.evaluate((i) => document.getElementById(i)!.click(), id)
      setTimeout(() => void click('mode-work'), 300)
      setTimeout(() => { void click('mode-chat'); flips.push(Date.now()) }, 1800)
    }
  }
  await driver.open(page, OPEN)
  opened = Date.now()
  assert.ok(opened >= flips[0]! + 1950, `the wait ended too early: the settle began again after the last change (${opened - flips[0]!} ms after it)`)
})


// WW1h: the mode wait with a stand-in engine, so the cases a page cannot be made to show are reachable.
type ModeEngine = { count: (element: string) => Promise<number>; resolve: (element: string, ms: number) => Promise<unknown>; state: (name: string) => Promise<boolean> }
const awaitMode = (engine: Partial<ModeEngine>, timeouts: DriverTimeouts) => {
  const driver = new ChatGptWebDriver({ origin: 'http://127.0.0.1:1', timeouts: { pollMs: 20, ...timeouts } })
  const stand: ModeEngine = { count: async () => 1, resolve: async () => ({ locator: { getAttribute: async () => 'true' } }), state: async () => false, ...engine }
  return (driver as unknown as { awaitModeSwitch(engine: ModeEngine): Promise<void> }).awaitModeSwitch(stand)
}

test('a mode the switch cannot tell is never stable: an unknown mode does not end the wait', { timeout: 30_000 }, async () => {
  const unknown = { resolve: async () => { throw new Error('no such element') } }
  await assert.rejects(awaitMode(unknown, { modeReadyMs: 500, modeSettleMs: 100 }), failure('ui_drift', /mode unknown/))
  const noState = { resolve: async () => ({ locator: { getAttribute: async () => null } }) }
  await assert.rejects(awaitMode(noState, { modeReadyMs: 500, modeSettleMs: 100 }), failure('ui_drift', /mode unknown/))
  await awaitMode({}, { modeReadyMs: 500, modeSettleMs: 100 })
})

test('the mode wait ends at its deadline even when a page operation never returns', { timeout: 30_000 }, async () => {
  for (const hung of [{ count: () => new Promise<number>(() => {}) }, { resolve: () => new Promise<never>(() => {}) }, { state: () => new Promise<boolean>(() => {}) }]) {
    const started = Date.now()
    await assert.rejects(awaitMode({ ...(hung.state ? { count: async () => 0 } : {}), ...hung }, { modeReadyMs: 300, modeSettleMs: 100 }), failure('ui_drift', /mode unknown/))
    assert.ok(Date.now() - started < 4000, `${Date.now() - started} ms`)
  }
})
