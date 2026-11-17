/**
 * The Procedure contract (conformance.ts) on two Sites, each a map and a fake page: the invented hostile Site
 * (fake-other.ts, ui/fake-other.ui.yaml) and ChatGPT's map on its fake page. Headed Chrome on a private Xvfb; no network.
 * Belongs to `test:web`.
 */
import { readFileSync } from 'node:fs'
import { after } from 'node:test'
import { skipHeaded } from '../../../test-support/headed.ts'
import { page, release } from './shared-chrome.ts'
import { shippedMap } from '../src/index.ts'
import { loadUiMap } from '../src/ui-ops/index.ts'
import { conformance, type Fixture, type Scenario } from './conformance.ts'
import { FakeChatGpt } from './fake-chatgpt.ts'
import { FakeOther } from './fake-other.ts'

const skip = skipHeaded
const opened: Array<() => Promise<unknown>> = []
after(async () => {
  for (const close of opened) await close()
})

const env = { skip, page, release }

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
  shows: { model: 'Latest', power: 'Instant' },
  levels: ['Instant', 'Low', 'Medium', 'High', 'Max'],
  async start(scenario: Scenario) {
    const fake = new FakeChatGpt({
      thinkMs: scenario.slow ? 1500 : 300, menuOpen: scenario.menuOpen ?? false, powerStuck: scenario.powerStuck ?? false, copied: (markdown) => markdown, codeWidget: !scenario.plainBlocks,
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
