/**
 * The ported driver against System 1's stand-in for chatgpt.com (fake-chatgpt.ts): what
 * the Runtime relies on (the sign-in states, a temporary chat in Chat mode, the answer
 * and its model read back). Headed Chrome on a private Xvfb; no network, no account.
 * System 1's own driver specs were cut from its suite (ADR-0084); the Runtime's
 * attempts are tested in packages/agents/tests/chatgpt.test.ts.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { BrowserContext, Page } from 'patchright-core'
import { CHROME, skipHeaded } from '../../../test-support/headed.ts'
import { launch, webDefaults } from '../../agents/src/chatgpt.ts'
import { startXvfb, type Display } from '../../agents/src/display.ts'
import { ChatGptWebDriver, ProviderError, shippedMap } from '../src/index.ts'
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
async function start(options: FakeOptions = {}): Promise<{ fake: FakeChatGpt; page: Page; driver: ChatGptWebDriver; context: BrowserContext }> {
  const fake = new FakeChatGpt({ thinkMs: 100, copied: (markdown) => markdown, ...options })
  await fake.start()
  const context = await launch({ ...webDefaults(join(root, `profile-${count++}`)), executablePath: CHROME }, display)
  opened.push(() => context.close().catch(() => {}), () => fake.stop())
  const driver = new ChatGptWebDriver({ origin: fake.origin, timeouts: { readyMs: 8000, turnMs: 20_000, stallMs: 10_000, stableMs: 500 } })
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
