/**
 * The Procedure contract as an executable suite (WW2-ii): `conformance(fixture, env)` registers the same tests for any Site,
 * given its UI map and a fake page that can be put into each scenario. A Site that passes needs only that map and that page,
 * no generic code of its own. What a fixture cannot do yet is listed in its `unsupported`, each with its reason, and shows as
 * a skipped test.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Page } from 'patchright-core'
import { type Baseline, Procedures, type Result, type UiMap } from '../src/index.ts'

export type Case = 'happy' | 'attach' | 'attach as chip' | 'temporary' | 'signed out' | 'challenge' | 'site error' | 'forbidden mode' | 'work composer' | 'mode switch absent' | 'unknown send' | 'previous answer' | 'previous answer, no markers' | 'labelled blocks' | 'plain blocks' | 'observe model' | 'observe model, menu left open' | 'select power' | 'select power, stuck'

/** What the page is made to do. A fixture maps each to its own page's options. */
export interface Scenario {
  /** The answer for a prompt (default "OK"). */
  answer?: (prompt: string) => string
  signedOut?: boolean
  challenge?: boolean
  /** The site gives up on the answer with its own error. */
  siteError?: boolean
  /** The send reaches the site and nothing shows it. */
  loseSend?: boolean
  /** The Site starts in a forbidden mode and cannot leave it. */
  forbiddenMode?: boolean
  /** The Site's input names the forbidden mode (a label that reads Work), whatever the switch shows. */
  workComposer?: boolean
  /** The mode switch never renders. */
  noModeSwitch?: boolean
  /** The answer takes over a second to start. */
  slow?: boolean
  /** A long paste becomes one attachment chip, finished a moment after the paste. */
  attachChip?: boolean
  /** Answers show as the live widget's labelled blocks. */
  labelledBlocks?: boolean
  /** Code blocks have no label at all (plain code, as the site shows an ordinary snippet). */
  plainBlocks?: boolean
  /** The Site's model menu is open when the page loads. */
  menuOpen?: boolean
  /** The Site's Power control ignores the keys: it never leaves its first level. */
  powerStuck?: boolean
}

export interface RunningSite {
  origin: string
  stop(): Promise<void>
  /** Prompts the site received so far. */
  sent(): number
}

export interface Fixture {
  name: string
  map: UiMap
  start(scenario: Scenario): Promise<RunningSite>
  /** The model and Power the page shows; none when the Site has no such control (the observation is then skipped). */
  shows?: { model: string; power: string }
  /** The Power levels the page offers, lowest first; none when the Site has no such control (a tier is then refused). */
  levels?: string[]
  /** Cases the fixture cannot run yet, with why. */
  unsupported?: Partial<Record<Case, string>>
}

export interface Env {
  /** A fresh Chrome page, closed after the file. */
  page(): Promise<Page>
  skip: string | boolean
}

/** Short clocks: the cases wait for what a fake page does in a moment. */
const quick = (map: UiMap): UiMap => ({ ...map, settings: { ...map.settings, modeReadyMs: 1500, modeSettleMs: 200, signedOutHoldMs: 500, sendAckMs: 2000, answerPollMs: 100, answerStableMs: 400, answerTimeoutMs: 20_000 } })

const BLOCKS = [
  { label: 'Final Report', code: '  indented line\n\n\ttabbed, with trailing spaces   \nunicode: ünï – 漢字 <b>&amp;</b>\n~~~~' },
  { label: 'sources.json', code: '{"a": 1}' },
]
const withBlocks = (): string => `Here is the answer.\n${BLOCKS.map((b) => `\`\`\`${b.label}\n${b.code}\n\`\`\``).join('\nBetween the blocks.\n')}\nSee [Example](https://example.org/a) for more.`

export function conformance(fixture: Fixture, env: Env): void {
  const map = quick(fixture.map)
  const hasModes = map.modes !== undefined

  /** Run `body` with a started site and Procedures bound to it. */
  async function on(scenario: Scenario, body: (p: Procedures, site: RunningSite) => Promise<void>, bound: UiMap = map): Promise<void> {
    const site = await fixture.start(scenario)
    const page = await env.page()
    const p = new Procedures(page, bound, { origin: site.origin, readyMs: 8000 })
    try {
      await body(p, site)
    } finally {
      p.dispose()
      // The browser goes first: a site's server waits for the page's open connections before it stops.
      await page.context().close().catch(() => undefined)
      await site.stop()
    }
  }

  const ok = <T>(result: Result<T>, what: string): T => {
    assert.equal(result.status, 'ok', `${what}: ${result.status} ${result.reason ?? ''} ${JSON.stringify(result.evidence)}`)
    return result.value as T
  }

  /** The way in to a composer that is ready: signed in, in the required mode, in a new chat. */
  async function ready(p: Procedures, temporary?: 'preferred'): Promise<void> {
    ok(await p.checkAuth(), 'checkAuth')
    ok(await p.ensureMode(), 'ensureMode')
    ok(await p.openChat(temporary ? { temporary } : {}), 'openChat')
  }

  async function ask(p: Procedures, prompt: string): Promise<Baseline> {
    ok(await p.insertInstructions(prompt), 'insertInstructions')
    return ok(await p.send(), 'send')
  }

  const run = (name: Case, options: { timeout?: number }, body: () => Promise<void>): void => {
    const reason = fixture.unsupported?.[name]
    void test(name, { skip: env.skip || (reason ? `not covered yet: ${reason}` : false), timeout: options.timeout ?? 60_000 }, body)
  }

  describe(`conformance: ${fixture.name}`, () => {
    run('happy', {}, () => on({ answer: (prompt) => `Answer to: ${prompt}` }, async (p, site) => {
      const auth = await p.checkAuth()
      assert.deepEqual([auth.status, auth.evidence.auth], ['ok', 'signed-in'])
      ok(await p.ensureMode(), 'ensureMode')
      ok(await p.openChat(), 'openChat')
      const baseline = await ask(p, 'What is 2+2?')
      assert.equal(site.sent(), 1)
      const waited = await p.waitForAnswer(baseline)
      assert.equal(waited.status, 'ok', JSON.stringify(waited))
      assert.equal(waited.value?.text, 'Answer to: What is 2+2?')
      const read = ok(await p.readAnswer(baseline), 'readAnswer')
      assert.equal(read.text, 'Answer to: What is 2+2?')
      assert.deepEqual([read.blocks, read.links], [[], []])
      // Evidence is counts and names, never the prompt or the answer.
      assert.doesNotMatch(JSON.stringify([auth, waited.evidence]), /2\+2/)
    }))

    // Read-only: the menu is closed again before anything is typed, and nothing is selected (what the page then sends proves it).
    for (const [name, menuOpen] of [['observe model', false], ['observe model, menu left open', true]] as const) {
      run(name, {}, () => on({ menuOpen }, async (p, site) => {
        await ready(p)
        assert.deepEqual(ok(await p.observeModel(), 'observeModel'), fixture.shows ?? { model: null, power: null })
        if (map.elements['model.menu']) assert.equal(await p.engine.count('model.menu'), 0, 'no menu is left open')
        ok(await p.insertInstructions('x'), 'insertInstructions')
        assert.equal(site.sent(), 0)
      }))
    }

    // The levels come from the live menu: economy is the first, standard the middle, frontier the last, and no tier is the middle.
    run('select power', {}, () => on({}, async (p, site) => {
      await ready(p)
      const levels = fixture.levels
      if (!levels) {
        // No such control: nothing is selected, and a tier asked of it is refused.
        assert.deepEqual(ok(await p.selectPower(), 'selectPower'), { power: null, level: null, total: null })
        const refused = await p.selectPower('standard')
        assert.equal(refused.status, 'failed', refused.reason)
        return
      }
      const middle = Math.ceil(levels.length / 2)
      for (const [tier, level] of [['economy', 1], ['standard', middle], ['frontier', levels.length], [undefined, middle], ['economy', 1]] as const) {
        assert.deepEqual(ok(await p.selectPower(tier), `selectPower ${tier}`), { power: levels[level - 1], level, total: levels.length }, `${tier}`)
        assert.equal(await p.engine.count('model.menu'), 0, 'the menu is closed')
      }
      ok(await p.insertInstructions('x'), 'insertInstructions')
      assert.equal(site.sent(), 0)
    }))

    run('select power, stuck', {}, () => on({ powerStuck: true }, async (p, site) => {
      await ready(p)
      if (!fixture.levels) return
      const result = await p.selectPower('frontier')
      assert.equal(result.status, 'failed')
      assert.match(result.reason!, /Power level 5 of 5 could not be set \(reads 1 of 5\)/)
      assert.equal(await p.engine.count('model.menu'), 0, 'the menu is closed')
      assert.equal(site.sent(), 0)
    }))

    run('attach', {}, () => on({}, async (p) => {
      await ready(p)
      const header = 'Header line.\n'
      ok(await p.insertInstructions(header), 'insertInstructions')
      const body = 'Body line one.\nBody line two.\n'.repeat(5)
      const outcome = ok(await p.attachText(body, header), 'attachText')
      // What the page shows decides: these fakes keep a short paste as text.
      assert.deepEqual(outcome, { outcome: 'text' })
    }))

    // The Site's own chip (its element, its label where its map says), never the engine's idea of one.
    run('attach as chip', {}, () => on({ attachChip: true, answer: () => 'OK' }, async (p, site) => {
      await ready(p)
      const header = 'Header line.\n'
      ok(await p.insertInstructions(header), 'insertInstructions')
      const body = 'Body line one, long enough to be kept as a file.\n'.repeat(8)
      assert.deepEqual(ok(await p.attachText(body, header), 'attachText'), { outcome: 'attachment' })
      const baseline = ok(await p.send(), 'send')
      assert.equal(site.sent(), 1)
      assert.equal(ok(await p.waitForAnswer(baseline), 'waitForAnswer').text, 'OK')
    }))

    run('temporary', {}, () => on({}, async (p) => {
      ok(await p.checkAuth(), 'checkAuth')
      ok(await p.ensureMode(), 'ensureMode')
      const required = await p.openChat({ temporary: 'required' })
      if (map.site?.temporaryChat) {
        assert.equal(required.status, 'ok')
        assert.equal(required.evidence.temporary, true)
      } else {
        // A Site with none: required fails explicitly, preferred goes on in a normal chat and says so.
        assert.equal(required.status, 'failed')
        assert.match(required.reason ?? '', /temporary chat is required/)
        assert.equal(required.evidence.temporary, false)
        const preferred = await p.openChat({ temporary: 'preferred' })
        assert.equal(preferred.status, 'ok')
        assert.equal(preferred.evidence.temporary, false)
        assert.ok(preferred.evidence.downgraded)
      }
    }))

    run('signed out', {}, () => on({ signedOut: true }, async (p) => {
      const auth = await p.checkAuth()
      assert.equal(auth.status, 'failed')
      assert.equal(auth.evidence.auth, 'signed-out')
    }))

    run('challenge', {}, () => on({ challenge: true }, async (p) => {
      const auth = await p.checkAuth()
      assert.equal(auth.status, 'failed')
      assert.equal(auth.evidence.auth, 'challenge')
    }))

    run('site error', {}, () => on({ siteError: true, answer: () => 'A partial answer that never finishes' }, async (p, site) => {
      await ready(p)
      const baseline = await ask(p, 'Anything')
      const waited = await p.waitForAnswer(baseline)
      // The site's own error is a failure of the answer, retryable by the caller, never an answer.
      assert.equal(waited.status, 'failed', JSON.stringify(waited))
      assert.deepEqual([waited.evidence.kind, waited.evidence.retryable], ['site-error', true])
      assert.equal(waited.value, undefined)
      const read = await p.readAnswer(baseline)
      assert.equal(read.status, 'failed')
      assert.equal(read.value, undefined)
      assert.equal(site.sent(), 1, 'nothing is resent')
    }))

    run('forbidden mode', {}, () => {
      if (!hasModes) return Promise.resolve()
      return on({ forbiddenMode: true }, async (p, site) => {
        ok(await p.checkAuth(), 'checkAuth')
        const mode = await p.ensureMode()
        assert.equal(mode.status, 'failed', JSON.stringify(mode))
        assert.equal(mode.evidence.mode, 'forbidden')
        // Refused before the send: the composer may hold the text, the click is never made.
        await p.insertInstructions('Do not send this').catch(() => undefined)
        const sent = await p.send()
        assert.equal(sent.status, 'failed')
        assert.equal(sent.evidence.outcome, 'rejected')
        assert.equal(site.sent(), 0)
      })
    })

    run('work composer', {}, () => {
      if (!hasModes) return Promise.resolve()
      return on({ workComposer: true }, async (p, site) => {
        ok(await p.checkAuth(), 'checkAuth')
        const mode = await p.ensureMode()
        assert.equal(mode.status, 'failed', JSON.stringify(mode))
        assert.equal(mode.evidence.mode, 'forbidden')
        await p.insertInstructions('Do not send this').catch(() => undefined)
        const sent = await p.send()
        assert.equal(sent.status, 'failed')
        assert.equal(sent.evidence.outcome, 'rejected')
        assert.equal(site.sent(), 0)
      })
    })

    run('mode switch absent', {}, () => {
      if (!hasModes) return Promise.resolve()
      return on({ noModeSwitch: true }, async (p) => {
        ok(await p.checkAuth(), 'checkAuth')
        const mode = await p.ensureMode()
        assert.equal(mode.status, 'unknown', JSON.stringify(mode))
        assert.equal(mode.evidence.mode, 'unverified')
      })
    })

    run('unknown send', {}, () => on({ loseSend: true }, async (p, site) => {
      await ready(p)
      ok(await p.insertInstructions('Is this sent?'), 'insertInstructions')
      const sent = await p.send()
      assert.equal(sent.status, 'unknown', JSON.stringify(sent))
      assert.equal(sent.evidence.outcome, 'unknown')
      // The prompt reached the site once. Nothing here sends it again, and an answer cannot be waited for as if it had been accepted.
      assert.equal(site.sent(), 1)
      const waited = await p.waitForAnswer(sent.value!, { timeoutMs: 600 })
      assert.equal(waited.status, 'unknown')
      assert.equal(site.sent(), 1)
    }))

    const previous = (scenario: Scenario, bound?: UiMap) => on({ ...scenario, slow: true, answer: (prompt) => (prompt.startsWith('first') ? 'The FIRST answer' : 'The SECOND answer') }, async (p, site) => {
      await ready(p)
      const first = await ask(p, 'first question')
      assert.equal(ok(await p.waitForAnswer(first), 'first wait').text, 'The FIRST answer')
      const second = await ask(p, 'second question')
      // The first answer, its done marker and its text still stand on the page: none of it is the new answer.
      const early = await p.waitForAnswer(second, { timeoutMs: 800 })
      assert.equal(early.status, 'unknown', JSON.stringify(early))
      const waited = await p.waitForAnswer(second)
      assert.equal(waited.value?.text, 'The SECOND answer')
      assert.equal(ok(await p.readAnswer(second), 'readAnswer').text, 'The SECOND answer')
      assert.equal(site.sent(), 2)
    }, bound)

    run('previous answer', {}, () => previous({}))

    // The baseline alone, with no running or done marker to lean on: only the text holding still can end the wait.
    run('previous answer, no markers', {}, () => previous({}, { ...map, answer: { ...map.answer, running: undefined, done: undefined } as UiMap['answer'] }))

    run('labelled blocks', {}, () => on({ labelledBlocks: true, answer: withBlocks }, async (p) => {
      await ready(p)
      const baseline = await ask(p, 'Give blocks')
      ok(await p.waitForAnswer(baseline), 'waitForAnswer')
      const read = ok(await p.readAnswer(baseline), 'readAnswer')
      // Labels and code as the page renders them: every character, row and blank line kept.
      assert.deepEqual(read.blocks, BLOCKS)
      for (const block of BLOCKS) assert.ok(read.text.includes(block.code), 'the text carries the block')
      assert.deepEqual(read.links, [{ href: 'https://example.org/a', text: 'Example' }])
    }))

    // A snippet with no header is not a failure of the read: its label is unknown, so it never fills an output by name.
    run('plain blocks', {}, () => on({ plainBlocks: true, answer: withBlocks }, async (p) => {
      await ready(p)
      const baseline = await ask(p, 'Give blocks')
      ok(await p.waitForAnswer(baseline), 'waitForAnswer')
      const read = await p.readAnswer(baseline)
      assert.equal(read.status, 'ok', JSON.stringify(read))
      assert.deepEqual(read.value!.blocks, BLOCKS.map((block) => ({ label: '', code: block.code })))
      assert.deepEqual(read.evidence.labels, 0)
    }))
  })
}
