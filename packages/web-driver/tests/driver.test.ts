/**
 * The ported driver against System 1's stand-in for chatgpt.com (fake-chatgpt.ts): what
 * the Runtime relies on (the sign-in states, a temporary chat in Chat mode, the answer
 * and its model read back). Headed Chrome on a private Xvfb; no network, no account.
 * System 1's own driver specs were cut from its suite (ADR-0084); the Runtime's
 * attempts are tested in packages/web-worker/tests/chatgpt.test.ts.
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
  const fake = new FakeChatGpt({ thinkMs: 100, copied: (markdown) => markdown, ...options })
  await fake.start()
  const context = await launch({ ...webDefaults(join(root, `profile-${count++}`)), executablePath: CHROME }, display)
  opened.push(() => context.close().catch(() => {}), () => fake.stop())
  const driver = new ChatGptWebDriver({ origin: fake.origin, timeouts: { readyMs: 8000, turnMs: 20_000, stallMs: 10_000, stableMs: 500, ...timeouts } })
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

test('a temporary turn starts in Chat mode, sends once, and returns the answer, no binding and the model read back', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ answer: 'The answer is **42**.' })
  const result = await driver.ask(page, 'What is the answer?', { conversation: 'temporary' })
  assert.equal(result.text, 'The answer is **42**.')
  assert.equal(result.binding, undefined)
  assert.equal(result.mode.model, 'Latest')
  assert.equal(fake.sent.length, 1)
  assert.deepEqual([fake.sent[0]!.prompt, fake.sent[0]!.mode, fake.sent[0]!.temporary], ['What is the answer?', 'chat', true])
})

// W8: the real site's answer came back as rendered text ("report\n...", no fences), so no output block was found.
const FENCED = 'Here:\n```report\nThe capital of France is Paris. [s1]\n```\n```sources\n{"sources":[{"id":"s1","url":"https://example.test/paris"}]}\n```'
for (const [name, copied] of [
  ['its Copy gives the text without fences', (markdown: string) => markdown.replace(/```([^\n]*)\n([\s\S]*?)\n```/g, '$1\n$2')],
  ['its Copy gives nothing', () => ''],
] as const) {
  test(`an answer's code blocks keep their fences when ${name}`, { skip, timeout: 60_000 }, async () => {
    const { page, driver } = await start({ answer: FENCED, copied })
    const result = await driver.ask(page, 'Report.', { conversation: 'temporary' })
    assert.match(result.text, /^```report\nThe capital of France is Paris\. \[s1\]\n```$/m)
    assert.match(result.text, /^```sources\n\{"sources":\[\{"id":"s1","url":"https:\/\/example\.test\/paris"\}\]\}\n```$/m)
  })
}

// The live site (2026-11-07) renders a code block with no `pre`: the language in its header bar, the text in `[data-code-block-source] code`.
test("an answer's code blocks keep their fences when the site renders them as code widgets", { skip, timeout: 60_000 }, async () => {
  const { page, driver } = await start({ answer: FENCED, copied: () => '', codeWidget: true })
  const result = await driver.ask(page, 'Report.', { conversation: 'temporary' })
  assert.match(result.text, /^```report\nThe capital of France is Paris\. \[s1\]\n```$/m)
  assert.match(result.text, /^```sources\n\{"sources":\[\{"id":"s1","url":"https:\/\/example\.test\/paris"\}\]\}\n```$/m)
})

// The live Copy (2026-11-07) keeps the fences but drops their info strings ("```\nhello\n```").
test("an answer's code blocks get their names back from the widget headers when Copy drops them", { skip, timeout: 60_000 }, async () => {
  const { page, driver } = await start({ answer: FENCED, copied: (markdown) => markdown.replace(/```[a-z]+\n/g, '```\n'), codeWidget: true })
  const result = await driver.ask(page, 'Report.', { conversation: 'temporary' })
  assert.match(result.text, /^```report\nThe capital of France is Paris\. \[s1\]\n```$/m)
  assert.match(result.text, /^```sources\n\{"sources":\[\{"id":"s1","url":"https:\/\/example\.test\/paris"\}\]\}\n```$/m)
})

// WW5a (live 2026-11-07): a review that contains code is written in a four-backtick fence; the site shows one widget labelled "review".
const NESTED = '````review\n## Verdict\nok\n```ts\nconst a = 1\n```\n````'
for (const [name, copied] of [
  ['drops the label', () => '````\n## Verdict\nok\n```ts\nconst a = 1\n```\n````'],
  ['gives nothing', () => ''],
  ['is right', () => NESTED],
] as const) {
  test(`a four-backtick block holding a code block is read whole when Copy ${name}`, { skip, timeout: 60_000 }, async () => {
    const { page, driver } = await start({ answer: NESTED, copied, codeWidget: true })
    const result = await driver.ask(page, 'Review.', { conversation: 'temporary' })
    assert.equal(result.text, NESTED)
  })
}

// WW5c: a tilde fence is closed only by tildes, so the code fences inside never end it.
const TILDES = '~~~~review\n## Verdict\nok\n```ts\nconst a = 1\n```\n~~~~'
for (const [name, copied] of [
  ['drops the label', () => '~~~~\n## Verdict\nok\n```ts\nconst a = 1\n```\n~~~~'],
  ['gives nothing', () => ''],
  ['is right', () => TILDES],
  ['loses the rows', () => '~~~~review\n## Verdict ok ```ts const a = 1 ```\n~~~~'],
] as const) {
  test(`a tilde-fenced block holding a code block is read whole when Copy ${name}`, { skip, timeout: 60_000 }, async () => {
    const { page, driver } = await start({ answer: TILDES, copied, codeWidget: true })
    const result = await driver.ask(page, 'Review.', { conversation: 'temporary' })
    assert.match(result.text, /^[`~]{3,}review\n## Verdict\nok\n```ts\nconst a = 1\n```\n[`~]{3,}$/m)
    assert.deepEqual(result.blocks, [{ label: 'review', code: '## Verdict\nok\n```ts\nconst a = 1\n```' }])
  })
}

// WW5b: the result also carries the final answer's rendered blocks as data, so a caller can fill an output from the block that names it.
test("an answer's rendered code blocks are returned as data: label and raw text, rows kept", { skip, timeout: 60_000 }, async () => {
  const { page, driver } = await start({ answer: NESTED, copied: () => '', codeWidget: true })
  const result = await driver.ask(page, 'Review.', { conversation: 'temporary' })
  assert.deepEqual(result.blocks, [{ label: 'review', code: '## Verdict\nok\n```ts\nconst a = 1\n```' }])
})

// WW1 defect 2: the Chat/Work switch was "not found" on the real site, with no page captured. A missing switch is no proof of
// Chat mode: the driver waits for it, bounded by the map's `settings.modeReadyMs`, and fails closed with the page's state named.
const MODE_WAIT = { modeReadyMs: 1500, modeSettleMs: 300 }
const failure = (kind: string, message: RegExp) => (error: unknown) => error instanceof ProviderError && error.kind === kind && message.test(error.message)

test('the shipped map bounds the wait for the mode switch', () => {
  const settings = shippedMap().settings
  assert.ok(settings.modeReadyMs >= 5000 && settings.modeReadyMs <= 60_000, JSON.stringify(settings))
  assert.ok(settings.modeSettleMs > 0)
})

test('a switch that appears late, after the composer, is waited for; nothing is typed before it', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ modeSwitchDelayMs: 1000 }, { ...MODE_WAIT, modeReadyMs: 8000 })
  const result = await driver.ask(page, 'Late switch.', { conversation: 'temporary' })
  assert.equal(result.text, 'OK')
  assert.deepEqual(fake.sent.map((sent) => sent.mode), ['chat'], 'the page started on Work: only Chat was ever sent')
})

test('a switch that never appears fails as an unknown mode at the deadline, with nothing sent', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ modeSwitch: false }, MODE_WAIT)
  const started = Date.now()
  await assert.rejects(driver.ask(page, 'No switch.', { conversation: 'temporary' }), failure('ui_drift', /mode unknown: the Chat\/Work switch did not appear within 1\.5 s/))
  assert.ok(Date.now() - started >= 1400, 'the wait was bounded by the setting, not skipped')
  assert.equal(fake.sent.length, 0)
})

test('a session that ends, or a challenge that appears, while the switch is awaited is named as such', { skip, timeout: 60_000 }, async () => {
  const out = await start({ modeSwitch: false, signOutAfterMs: 300 }, MODE_WAIT)
  await assert.rejects(out.driver.ask(out.page, 'x', { conversation: 'temporary' }), failure('reauth_required', /signed out/))
  const challenged = await start({ modeSwitch: false, challengeAfterMs: 300 }, MODE_WAIT)
  await assert.rejects(challenged.driver.ask(challenged.page, 'x', { conversation: 'temporary' }), failure('challenge', /challenge/))
  assert.equal(out.fake.sent.length + challenged.fake.sent.length, 0)
})

test('a mode that changes while the switch is awaited is read again, and only Chat is sent', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ startOnWork: false, modeSwitchDelayMs: 200, modeFlipToWorkMs: 150 }, { ...MODE_WAIT, modeReadyMs: 8000 })
  await driver.ask(page, 'Flip.', { conversation: 'temporary' })
  assert.deepEqual(fake.sent.map((sent) => sent.mode), ['chat'])
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
  await assert.rejects(driver.ask(page, 'Slow settle.', { conversation: 'temporary' }), failure('ui_drift', /mode unknown/))
  assert.ok(Date.now() - started < 2400, `ended at the deadline, not after the settle (${Date.now() - started} ms)`)
  assert.equal(fake.sent.length, 0)
})

test('a mode that leaves Chat and comes back inside the settle interval restarts it', { skip, timeout: 60_000 }, async () => {
  const { page, driver } = await start({ startOnWork: false }, { modeReadyMs: 20_000, modeSettleMs: 2000 })
  const flips: number[] = []
  let sent = 0
  driver.onStage = ({ stage, status }) => {
    if (stage === 'mode' && status === 'start') {
      const click = (id: string) => page.evaluate((i) => document.getElementById(i)!.click(), id)
      setTimeout(() => void click('mode-work'), 300)
      setTimeout(() => { void click('mode-chat'); flips.push(Date.now()) }, 1800)
    }
    if (stage === 'insert' && status === 'start') sent = Date.now()
  }
  await driver.ask(page, 'Blip.', { conversation: 'temporary' })
  assert.ok(sent >= flips[0]! + 1950, `the wait ended too early: the settle began again after the last change (${sent - flips[0]!} ms after it)`)
})

// WW1c: keyboard.insertText of 66 KB into the live editor took 5.5 min; the composer takes one paste instead.
const longPrompt = (bytes: number) => Array.from({ length: Math.ceil(bytes / 60) }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join('\n')

test('a 60 KB prompt goes into the composer as one paste, intact and fast, as its own stage', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start()
  const stages: string[] = []
  driver.onStage = ({ stage, status }) => { if (status === 'start') stages.push(stage) }
  const prompt = longPrompt(60_000)
  const started = Date.now()
  await driver.ask(page, prompt, { conversation: 'temporary', beforeSend: async () => { assert.equal(await page.locator('#input').getAttribute('data-pasted'), '1') } })
  assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`)
  assert.equal(fake.sent[0]!.prompt, prompt)
  assert.ok(stages.indexOf('insert') > stages.indexOf('mode') && stages.indexOf('insert') < stages.indexOf('send'), stages.join())
})

test('a paste the composer does not take falls back to typed text', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ pasteTaken: false })
  await driver.ask(page, 'Typed instead.\nSecond line.', { conversation: 'temporary' })
  assert.equal(fake.sent[0]!.prompt, 'Typed instead.\nSecond line.')
})

// WW1g: on a Team workspace a 61,581-character paste became an attachment chip, not composer text (live 2026-11-07);
// on another account of the same site it stayed text. A prompt is a header typed in the composer and a body pasted after it.
const HEADER = 'Header: read the attached inputs.\n'
const BODY = `Inputs:\n${longPrompt(5000)}`

/** The stages and the outcome one ask reports. */
function watch(driver: ChatGptWebDriver): { stages: string[]; attached: unknown[] } {
  const seen = { stages: [] as string[], attached: [] as unknown[] }
  driver.onStage = ({ stage, status }) => { if (status === 'start') seen.stages.push(stage) }
  driver.onAttached = (outcome) => seen.attached.push(outcome)
  return seen
}

test('a body pasted as an attachment chip is accepted: one new chip named by its text, once it is no longer adding', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ attachOver: 1000, attachAddingMs: 700 })
  const seen = watch(driver)
  await driver.ask(page, HEADER, { conversation: 'temporary', attachment: BODY })
  assert.deepEqual(seen.attached, [{ outcome: 'attachment', chips: 1 }])
  assert.deepEqual(seen.stages.filter((s) => s === 'insert' || s === 'attach'), ['insert', 'attach'])
  assert.equal(fake.sent.length, 1)
  assert.equal(fake.sent[0]!.prompt, `${HEADER.trim()}\n${BODY}`)
})

test('a body the composer keeps as text is accepted and read back, as before', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ attachOver: 0 })
  const seen = watch(driver)
  await driver.ask(page, HEADER, { conversation: 'temporary', attachment: BODY })
  assert.deepEqual(seen.attached, [{ outcome: 'text', chips: 0 }])
  assert.equal(fake.sent[0]!.prompt.replace(/\n+/g, '\n'), `${HEADER.trim()}\n${BODY}`.replace(/\n+/g, '\n'))
})

test('a chip that does not start with the body fails in the attach stage, with nothing sent', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ attachOver: 1000, attachWrongLabel: true }, { attachWaitMs: 2000 })
  const stages: string[] = []
  driver.onStage = ({ stage, status }) => { if (status === 'failed') stages.push(stage) }
  await assert.rejects(driver.ask(page, HEADER, { conversation: 'temporary', attachment: BODY }), (error: unknown) => error instanceof ProviderError && /attach/.test(error.message))
  assert.deepEqual(stages, ['attach'])
  assert.equal(fake.sent.length, 0)
})

test('a chip still being added at the deadline fails in the attach stage, with nothing sent', { skip, timeout: 60_000 }, async () => {
  const { fake, page, driver } = await start({ attachOver: 1000, attachAddingMs: 60_000 }, { attachWaitMs: 1500 })
  const stages: string[] = []
  driver.onStage = ({ stage, status }) => { if (status === 'failed') stages.push(stage) }
  await assert.rejects(driver.ask(page, HEADER, { conversation: 'temporary', attachment: BODY }), (error: unknown) => error instanceof ProviderError && /still being added/.test(error.message))
  assert.deepEqual(stages, ['attach'])
  assert.equal(fake.sent.length, 0)
})

// WW1h: binding the conversation is part of the read stage: one start and one end of it, whichever way it ends.
test('a persistent turn reports the read stage once, with the binding checked inside it', { skip, timeout: 60_000 }, async () => {
  const { page, driver } = await start()
  const events: string[] = []
  driver.onStage = ({ stage, status }) => { if (stage === 'read') events.push(status) }
  const result = await driver.ask(page, 'Persistent.', { conversation: 'persistent' })
  assert.ok(result.binding)
  assert.deepEqual(events, ['start', 'ok'])
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
