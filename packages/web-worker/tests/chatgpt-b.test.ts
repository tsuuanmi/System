/**
 * chatgpt Worker, part 2: profile preparation, Chrome launch, review and block reading.
 * Split from the former chatgpt.test.ts (web-2): see chatgpt-support.ts.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Artifacts } from '@system/artifacts'
import { FakeChatGpt, type FakeOptions } from '../../web-driver/tests/fake-chatgpt.ts'
import { CHROME, skipHeaded } from '../../../test-support/headed.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { CONVERSATION_KIND, TASK_KIND, conversationSchema, taskSchema, type Conversation, type WorkerRequest, type WorkerResult } from '@system/work'
import { CHROME_ARGS, IGNORED_DEFAULT_ARGS, chromeTmpdir, launch, launchTimeoutMs, parseBlocks, prepareProfile, stripLanguageLabel, stripLeaked, unblocked, profileLockPid, singleTab, webAttempt, webDefaults, webPrompt, webWorker, type WebAccount, type WebConfig } from '../src/chatgpt.ts'
import { parseCookies, webLogin } from '../src/chatgpt-login.ts'
import { sharedDisplay, skip, root, site, blocks, web, run, text, sleep, evidenceOf } from './chatgpt-support.ts'

for (const end of ['a clean close', 'a SIGKILL'] as const) {
  test(`a profile that held several tabs opens one tab after ${end}, and its session cookie survives a clean one`, { skip, timeout: 120_000 }, async () => {
    const fake = await site()
    const config = web(fake)
    const display = sharedDisplay()
    const open: Array<Awaited<ReturnType<typeof launch>>> = []
    try {
      const first = await launch(config, display)
      open.push(first)
      await first.addCookies([{ name: 'kept', value: 'v', url: fake.origin }])
      for (let i = 0; i < 4; i++) await (await first.newPage()).goto(`${fake.origin}/?tab=${i}`)
      await sleep(1500)
      assert.ok(first.pages().length >= 5)
      if (end === 'a clean close') {
        await first.close()
      } else {
        process.kill(profileLockPid(config.profileDir)!, 'SIGKILL')
        await sleep(1500)
      }
      const second = await launch(config, display)
      open.push(second)
      await sleep(2500)
      assert.deepEqual(second.pages().map((page) => page.url()), ['about:blank'], 'nothing was restored')
      if (end === 'a clean close') assert.ok((await second.cookies(fake.origin)).some((cookie) => cookie.name === 'kept'), 'the session-only cookie is still there')
      await second.close()
    } finally {
      await Promise.all(open.map((context) => context.close().catch(() => {})))
    }
  })
}

test('the worker tab is opened first, every other page is closed, and a page that arrives late is closed too', { skip, timeout: 60_000 }, async () => {
  const fake = await site()
  const display = sharedDisplay()
  let context: Awaited<ReturnType<typeof launch>> | undefined
  try {
    context = await launch(web(fake), display)
    for (let i = 0; i < 3; i++) await (await context.newPage()).goto(`${fake.origin}/?tab=${i}`)
    const tabs = await singleTab(context)
    assert.equal(tabs.initial, 4)
    assert.equal(tabs.closed, 4)
    assert.deepEqual(context.pages(), [tabs.page], 'one working tab')
    await tabs.page.goto(`${fake.origin}/`)
    await tabs.page.evaluate(() => { window.open('about:blank') })
    await sleep(1000)
    assert.deepEqual(context.pages(), [tabs.page], 'the late tab is gone')
    assert.equal(tabs.late(), 1)
    await context.close()
  } finally {
    await context?.close().catch(() => {})
  }
})

// WW5b (live 2026-11-07): one widget labelled `review` whose raw text holds ```ts and ```json fences, and Copy gives nothing.
const REVIEW = '## 1. Verdict\n\nneeds changes\n\n## 2. Defects\n\n```ts\nconst before = 1\n```\n\n```json\n{"a":1}\n```'

test('an output is filled verbatim from the rendered block that carries its name, and the evidence says so', { skip, timeout: 120_000 }, async () => {
  const { artifacts, result } = await run({ answer: '````review\n' + REVIEW + '\n````', copied: () => '', codeWidget: true }, ['review'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.review!), REVIEW)
  const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
  assert.deepEqual(JSON.parse(line.slice(line.indexOf('{'))).filled, { review: 'block' })
})

// WW5d (live 2026-11-08, web/chatgpt/default): the site shows "~~~~report" as paragraph text and its Copy escapes the Markdown.
const escapedCopy = (markdown: string) => markdown.replace(/[~:]/g, (c) => `\\${c}`).replace(/\n/g, '\\\n')
const PARAGRAPHS = '~~~~report\nThe capital of France is Paris. [s1]\n~~~~\n\n~~~~sources\n[{"id":"s1","url":"https://en.wikipedia.org/wiki/Paris"}]\n~~~~'

test('outputs are filled from the rendered text when the site shows the fences as text and its Copy escapes them', { skip, timeout: 120_000 }, async () => {
  const { artifacts, result } = await run({ answer: PARAGRAPHS, copied: escapedCopy, literalFences: true }, ['report', 'sources'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.report!), 'The capital of France is Paris. [s1]')
  assert.equal(await text(artifacts, result.outputs.sources!), '[{"id":"s1","url":"https://en.wikipedia.org/wiki/Paris"}]')
  const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
  assert.deepEqual(JSON.parse(line.slice(line.indexOf('{'))).filled, { report: 'rendered', sources: 'rendered' })
})

test('an output is never filled from escaped Markdown: without a fence in the rendered text the attempt fails', { skip, timeout: 120_000 }, async () => {
  const { result } = await run({ answer: 'no fences here, only https://example.org', copied: () => '\\~\\~\\~\\~report\\\nx\\\n\\~\\~\\~\\~ https\\://example.org', literalFences: true }, ['report'])
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /wrote no output block for report/)
})

test('the outside limit counts the rendered text when the outputs were filled from it', { skip, timeout: 120_000 }, async () => {
  const { result } = await run({ answer: `${'A long remark before the block. '.repeat(10)}\n\n~~~~report\nthe report\n~~~~`, copied: escapedCopy, literalFences: true }, ['report'])
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /continues outside its output blocks/)
})

test('two rendered blocks with the label of an output are ambiguous: the attempt fails with that reason', { skip, timeout: 120_000 }, async () => {
  const { result } = await run({ answer: '```review\nfirst\n```\n\n```review\nsecond\n```', copied: () => '', codeWidget: true }, ['review'])
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /review.*ambiguous|ambiguous.*review/)
})

// nm-4: a research answer with a snippet the site shows with no header bar among its labelled blocks: the labels were dropped, so no output was found.
test('a snippet with no header among the labelled blocks does not hide the outputs by name', { skip, timeout: 120_000 }, async () => {
  const answer = ['Method.', '', '```', 'curl https://example.org', '```', '', '```report', 'the report', '```', '', '```sources', '[{"id":"s1"}]', '```'].join('\n')
  const { artifacts, result } = await run({ answer, bareSnippets: true }, ['report', 'sources'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.report!), 'the report')
  assert.equal(await text(artifacts, result.outputs.sources!), '[{"id":"s1"}]')
})

// WW5c (live 2026-11-07): a tilde fence is closed only by tildes, so a review holding ```ts and ```json is one block, whole.
test('a tilde-fenced review holding code fences fills its output verbatim from the rendered block', { skip, timeout: 120_000 }, async () => {
  const { artifacts, result } = await run({ answer: '~~~~review\n' + REVIEW + '\n~~~~' }, ['review'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.review!), REVIEW)
})

// The real shape: a three-backtick `review` block that its own inner fence closes, the rest of the review after it.
const CUT = '```review\n## 1. Verdict\n\nneeds changes\n\n```ts\nconst before = 1\n```\n\n## 2. Defects\n\n' + 'A long finding about the code that went on after the block closed. '.repeat(8) + '\n\n```json\n{"a":1}\n```'
test('an answer that continues outside its output block fails and is kept as partial output', { skip, timeout: 120_000 }, async () => {
  const { artifacts, result } = await run({ answer: CUT }, ['review'])
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /the answer continues outside its output blocks \(\d+ characters\): an output may be cut short/)
  assert.ok(result.partial!.review, 'what was found is kept')
  assert.equal(await text(artifacts, result.partial!.review!), '## 1. Verdict\n\nneeds changes\n\n```ts\nconst before = 1')
  assert.ok(result.partial!.conversation)
  assert.match(String((await evidenceOf(artifacts, result)).outsideChars), /^\d+$/)
})

test('the outside limit is a setting: a short remark outside the block is fine, and a tighter limit refuses it', { skip, timeout: 120_000 }, async () => {
  const answer = 'Done, here it is.\n\n~~~~review\nthe review\n~~~~'
  const ok = await run({ answer }, ['review'])
  assert.equal(ok.result.status, 'succeeded', ok.result.reason)
  const tight = await run({ answer }, ['review'], { config: { maxOutsideChars: 5 } })
  assert.equal(tight.result.status, 'failed')
  assert.match(tight.result.reason!, /continues outside its output blocks \(14 characters\)/)
})

// WW8a: the model and Power the page showed are recorded; WW8b: the Power is then selected from the step's tier.
// The levels come from the live menu (five on this page): economy is the first, standard the middle, frontier the last, no tier the middle.
// web-4: also the former WW8a test: the evidence records the model and Power the page showed before (all runs), and a menu left open (the last run) is closed before the insert.
test('a step selects the Power level of its tier before the send, the evidence says what was chosen and what the page showed before, and a menu left open is closed before the insert', { skip, timeout: 180_000 }, async () => {
  for (const [tier, power, target] of [['economy', 'Instant', 'economy'], ['standard', 'Medium', 'standard'], ['frontier', 'Max', 'frontier'], [undefined, 'Medium', 'standard']] as const) {
    const menuOpen = tier === undefined
    const { artifacts, result, fake } = await run({ menuOpen }, ['report'], { tier })
    assert.equal(result.status, 'succeeded', `${tier}: ${result.reason}`)
    const evidence = await evidenceOf(artifacts, result)
    assert.equal(evidence.model, 'Latest', `${tier}`)
    const observe = evidence.stages.find((stage: { stage: string }) => stage.stage === 'observe')
    assert.deepEqual([observe.status, typeof observe.elapsedMs], ['ok', 'number'])
    assert.equal(fake.sent[0]!.model, 'Latest', 'no model was selected')
    assert.deepEqual([evidence.power, evidence.powerTarget, evidence.powerLevels, evidence.powerBefore], [power, target, 5, 'Instant'], `${tier}`)
    assert.deepEqual([fake.sent[0]!.power, fake.sent[0]!.menuOpen], [power, false], `${tier}`)
    const stages = evidence.stages.map((stage: { stage: string }) => stage.stage)
    assert.ok(stages.indexOf('power') > stages.indexOf('observe') && stages.indexOf('power') < stages.indexOf('insert'), 'selected between the observation and the insert')
  }
})

test('a Power slider that stays at one level fails before the send, and the evidence says why', { skip, timeout: 120_000 }, async () => {
  const { artifacts, result, fake } = await run({ powerStuck: true }, ['report'], { tier: 'frontier' })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /Power level 5 of 5 could not be set \(reads 1 of 5\)/)
  assert.equal(fake.sent.length, 0)
  const evidence = await evidenceOf(artifacts, result)
  assert.deepEqual([evidence.promptSendAttempted, evidence.promptSubmitted, evidence.failedStage, evidence.powerTarget, evidence.powerLevels], [false, false, 'power', 'frontier', 5])
  assert.equal(evidence.power, undefined)
})

// The map binds a Power control: a page that has lost it is drift, and the attempt stops before anything is typed.
test('a page whose model control is gone records null and stops before the send', { skip, timeout: 120_000 }, async () => {
  const { artifacts, result, fake } = await run({ modelPicker: false }, ['report'])
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /no candidate of composer\.model matched/)
  assert.equal(fake.sent.length, 0)
  const evidence = await evidenceOf(artifacts, result)
  assert.deepEqual([evidence.model, evidence.powerBefore, evidence.failedStage, evidence.promptSendAttempted], [null, null, 'power', false])
})
