/**
 * The Procedure contract (conformance.ts) on two Sites, each a map and a fake page: the invented hostile Site
 * (fake-other.ts, ui/fake-other.ui.yaml) and ChatGPT's map on its fake page. Headed Chrome on a private Xvfb; no network.
 * Belongs to `test:web`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before } from 'node:test'
import { CHROME, skipHeaded } from '../../../test-support/headed.ts'
import { launch, webDefaults } from '../../web-worker/src/chatgpt.ts'
import { startXvfb, type Display } from '../../web-worker/src/display.ts'
import { shippedMap } from '../src/index.ts'
import { loadUiMap } from '../src/ui-ops/index.ts'
import { conformance, type Fixture, type Scenario } from './conformance.ts'
import { FakeChatGpt } from './fake-chatgpt.ts'
import { FakeOther } from './fake-other.ts'

const skip = skipHeaded
const root = mkdtempSync(join(tmpdir(), 'system-conformance-'))
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
const env = {
  skip,
  async page() {
    const context = await launch({ ...webDefaults(join(root, `profile-${count++}`)), executablePath: CHROME }, display)
    opened.push(() => context.close().catch(() => {}))
    return context.pages()[0] ?? context.newPage()
  },
}

const other: Fixture = {
  name: 'fake-other (hostile)',
  map: loadUiMap(readFileSync(new URL('../ui/fake-other.ui.yaml', import.meta.url), 'utf8')),
  async start(scenario: Scenario) {
    const fake = new FakeOther({ ...(scenario.slow ? { thinkMs: 1500 } : {}), signedIn: !scenario.signedOut, challenge: scenario.challenge ?? false, failAnswer: scenario.siteError ?? false, dropSend: scenario.loseSend ?? false, ...(scenario.attachChip ? { attachOver: 100 } : {}), ...(scenario.plainBlocks ? { plainBlocks: true } : {}), ...(scenario.answer ? { answer: scenario.answer } : {}) })
    await fake.start()
    opened.push(() => fake.stop())
    return { origin: fake.origin, stop: () => fake.stop(), sent: () => fake.sent.length }
  },
}

const chatgpt: Fixture = {
  name: 'chatgpt-web',
  map: shippedMap(),
  async start(scenario: Scenario) {
    const fake = new FakeChatGpt({
      thinkMs: scenario.slow ? 1500 : 300, copied: (markdown) => markdown, codeWidget: !scenario.plainBlocks,
      signedIn: !scenario.signedOut, captcha: scenario.challenge ?? false, loadFailure: scenario.siteError ?? false, dropSend: scenario.loseSend ?? false,
      ...(scenario.attachChip ? { attachOver: 100, attachAddingMs: 300 } : {}),
      chatToggleBroken: scenario.forbiddenMode ?? false, ...(scenario.workComposer ? { startOnWork: false, workComposer: true } : {}), modeSwitch: !scenario.noModeSwitch, ...(scenario.noModeSwitch ? { startOnWork: false } : {}),
      ...(scenario.answer ? { answer: scenario.answer } : {}),
    })
    await fake.start()
    opened.push(() => fake.stop())
    return { origin: fake.origin, stop: () => fake.stop(), sent: () => fake.sent.length }
  },
}

conformance(other, env)
conformance(chatgpt, env)
