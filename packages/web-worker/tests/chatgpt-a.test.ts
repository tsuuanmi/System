/**
 * chatgpt Worker, part 1: block parsing, launch, one exchange, outputs.
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
import { sharedDisplay, skip, root, site, blocks, memory, web, account, request, task, run, text, conversationOf, evidenceOf } from './chatgpt-support.ts'


test('Chrome starts when TMPDIR is too deep for its profile socket', { skip, timeout: 60_000 }, async () => {
  // Chrome puts SingletonSocket under TMPDIR and aborts ("Socket path too long") past 107 bytes: a throwaway HOME is that deep.
  const deep = join(root, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40))
  mkdirSync(deep, { recursive: true })
  const was = process.env.TMPDIR
  process.env.TMPDIR = deep
  const fake = await site()
  const display = sharedDisplay()
  let context: Awaited<ReturnType<typeof launch>> | undefined
  try {
    context = await launch(web(fake), display)
    await context.close()
  } finally {
    await context?.close().catch(() => {})
    if (was === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = was
  }
})

test('one prompt is sent in a temporary chat in Chat mode, the answer is awaited, each labelled block fills its slot, and the exchange is stored as a conversation with its links and a small input kept in one part', { skip, timeout: 60_000 }, async () => {
  // One flow, one browser: the former "one prompt", "stored as a conversation", "links inside the answer" and "no inputs or small ones stay one part" tests (web-4).
  const answer = `${blocks('report', 'sources')}\nSee [source A](https://example.org/a) and [source B](https://example.org/b?x=1).`
  const { artifacts, result, fake } = await run({ answer, attachOver: 1000 }, ['report', 'sources'], { instructions: 'Explain the fake topic.', note: 'a short note' })
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.report!), 'content of report\nsecond line')
  assert.equal(await text(artifacts, result.outputs.sources!), 'content of sources\nsecond line')
  assert.equal(fake.sent.length, 1)
  assert.equal(fake.sent[0]!.temporary, true)
  assert.equal(fake.sent[0]!.mode, 'chat', 'the page started on Work: the driver switched it before anything was typed')
  assert.match(fake.sent[0]!.prompt, /"~~~~report"/)
  assert.match(fake.sent[0]!.prompt, /a short note/)
  assert.equal(result.usage, undefined, 'the web UI shows no token counts')
  assert.deepEqual(result.executor, { ref: 'web/chatgpt/default', account: 'chatgpt/default', command: CHROME, version: 'fake' })
  assert.ok(result.log)
  const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
  const evidence = JSON.parse(line.slice(line.indexOf('{')))
  assert.ok(!evidence.stages.some((stage: { stage: string }) => stage.stage === 'attach'))
  assert.equal(evidence.attach, undefined)
  const { occurrences, content } = conversationOf(artifacts, result)
  assert.deepEqual(occurrences.map((o) => o.producer), [{ type: 'worker', ref: 'web/chatgpt/default' }])
  assert.equal(content.asserted.provider, 'ChatGPT')
  assert.match(content.asserted.url!, /^http:\/\/127\.0\.0\.1:\d+\/c\/[0-9a-f-]{36}\?temporary-chat=true$/, 'the site\'s own address of a temporary chat')
  // The Procedures read no model into the conversation: its record has none, never a guess.
  assert.equal(content.asserted.model, undefined, 'the model the page read back as selected')
  assert.deepEqual(content.asserted.context, ['ui-map:2026-10-11', 'temporary-chat'])
  const [prompt, response] = content.parts
  assert.deepEqual([prompt!.role, response!.role], ['prompt', 'response'])
  const sent = await text(artifacts, prompt!.artifact)
  assert.match(sent, /Explain the fake topic\./)
  assert.match(sent, /"~~~~report"/)
  const rendered = await text(artifacts, response!.artifact)
  // The response is the page's rendered text: its words, with the block as the page shows it.
  assert.match(rendered, /report\ncontent of report\nsecond line/)
  const links = content.parts.find((p) => p.role === 'attachment')!
  assert.equal(links.name, 'links.json')
  assert.deepEqual(JSON.parse(await text(artifacts, links.artifact)), ['https://example.org/a', 'https://example.org/b?x=1'])
})

// WW1g: a prompt with inputs is a header typed in the composer and a body pasted after it, which the site may turn into an attachment.
const NOTE = `Notes of the review:\n${Array.from({ length: 200 }, (_, i) => `note ${i}: the quick brown fox jumps over the lazy dog`).join('\n')}`

test('a prompt with inputs is a header and a body: the body is accepted as a chip or as text, and the evidence says which', { skip, timeout: 120_000 }, async () => {
  for (const [options, outcome, chips] of [[{ attachOver: 1000 }, 'attachment', 1], [{ attachOver: 0 }, 'text', 0]] as const) {
    const { artifacts, result, fake } = await run(options, ['report'], { note: NOTE })
    assert.equal(result.status, 'succeeded', result.reason)
    const sent = fake.sent[0]!.prompt
    assert.match(sent, /"~~~~report"/)
    assert.ok(sent.includes('note 199: the quick brown fox'), 'the inputs went with the prompt')
    assert.ok(sent.indexOf('Complete this one step') < sent.indexOf('note 0:'), 'the header comes before the body')
    const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
    const evidence = JSON.parse(line.slice(line.indexOf('{')))
    assert.deepEqual(evidence.stages.map((stage: { stage: string }) => stage.stage), ['launch', 'open', 'auth', 'mode', 'observe', 'power', 'insert', 'attach', 'send', 'wait', 'read', 'close'])
    assert.deepEqual(evidence.attach, { outcome, chips })
  }
})

test('a chip that is not the body fails in the attach stage before the send, with the page as evidence', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result, fake } = await run({ attachOver: 1000, attachWrongLabel: true }, ['report'], { note: NOTE, config: { timeouts: { load: 10, answer: 20, stable: 0.5, attach: 1.5 } } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /attach text failed/)
  assert.equal(fake.sent.length, 0)
  const evidence = await evidenceOf(artifacts, result)
  assert.equal(evidence.failedStage, 'attach')
  assert.equal(evidence.promptSendAttempted, false)
  assert.ok(result.partial!.screenshot && result.partial!.snapshot)
})

// nm-4 (work:9dda9b91): the site kept "Adding pasted text" for a 44 KB input; that is the site's, and the reason says what to change.
test('an input the site never finishes adding fails with its size and what to change, before the send', { skip, timeout: 60_000 }, async () => {
  const big = `Notes:\n${Array.from({ length: 800 }, (_, i) => `note ${i}: the quick brown fox jumps over the lazy dog`).join('\n')}`
  const { result, fake } = await run({ attachOver: 1000, attachAddingMs: 60_000 }, ['report'], { note: big, config: { timeouts: { load: 10, answer: 20, stable: 0.5, attach: 1.5 } } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /attach text failed: the attachment was still being added after 1500 ms/)
  assert.match(result.reason!, /input of \d+ KB/)
  assert.match(result.reason!, /shorten the input|timeouts\.attach/)
  assert.equal(fake.sent.length, 0)
})

test('with temporaryChat off the chat is a conversation of the account, bound by its id', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result, fake } = await run({}, ['report'], { config: { temporaryChat: false } })
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(fake.sent[0]!.temporary, false)
  const { content } = conversationOf(artifacts, result)
  assert.match(content.asserted.url!, /\/c\/[0-9a-f-]{36}$/)
  assert.deepEqual(content.asserted.context, ['ui-map:2026-10-11'])
})

test('a sign-in wall fails the attempt with a screenshot as partial output', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result, fake } = await run({ signedIn: false })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /signed out; sign in again/)
  assert.deepEqual(result.outputs, {})
  assert.equal(fake.sent.length, 0)
  assert.deepEqual([...(await artifacts.readBytes(result.partial!.screenshot!)).slice(1, 4)], [...Buffer.from('PNG')])
})

test('a CAPTCHA or Cloudflare challenge fails the attempt and is never typed into', { skip, timeout: 60_000 }, async () => {
  const { result, fake } = await run({ captcha: true })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /challenge/)
  assert.equal(fake.sent.length, 0)
  assert.ok(result.partial?.screenshot)
})

test('the logged-out shell of an app that is still loading its session is held, then the attempt goes on', { skip, timeout: 60_000 }, async () => {
  const { result } = await run({ logoutFlashMs: 1500 })
  assert.equal(result.status, 'succeeded', result.reason)
})

test('a logged-out home that stays without a composer counts as signed out, after being held', { skip, timeout: 60_000 }, async () => {
  const started = Date.now()
  const { result } = await run({ loggedOutHome: true })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /signed out/)
  assert.ok(Date.now() - started >= 3000, 'decided before the hold')
})

test('the site\'s own error page is loaded once more before anything is typed', { skip, timeout: 60_000 }, async () => {
  const { result, fake } = await run({ errorPages: 1 })
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(fake.errorPagesShown, 1)
})

test('Work is never used: a switch that stays on Work, or a composer that names Work, ends the attempt before anything is sent', { skip, timeout: 60_000 }, async () => {
  for (const [options, reason] of [
    [{ chatToggleBroken: true }, /a forbidden mode holds \(mode\.work-selected\)/],
    [{ startOnWork: false, workComposer: true }, /a forbidden mode holds \(mode\.work-composer\)/],
  ] as const) {
    const { artifacts, result, fake } = await run(options)
    assert.equal(result.status, 'failed', JSON.stringify(options))
    assert.match(result.reason!, reason)
    assert.equal(fake.sent.length, 0, 'nothing was sent')
    assert.equal(result.partial?.conversation, undefined, 'nothing was sent, so nothing was recorded')
    assert.ok(result.partial?.screenshot)
    assert.ok(artifacts)
  }
})

test('a page that is neither signed in nor signed out fails with the unknown page state, outlined as drift', { skip, timeout: 60_000 }, async () => {
  const { result } = await run({ interstitial: true }, ['report'], { config: { timeouts: { load: 1.5, answer: 5, stable: 0.5 } } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /neither the composer nor a sign-in page/)
  assert.ok(result.partial?.screenshot)
})

test('a leaked control token at the edge of an output is removed and recorded; one inside the content is kept', { skip, timeout: 60_000 }, async () => {
  const answer = ['```sources', '<escape>{"sources": []}', '```', '', '```report', 'a literal <escape> inside', '```'].join('\n')
  const { artifacts, result } = await run({ answer }, ['sources', 'report'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.sources!), '{"sources": []}')
  assert.equal(await text(artifacts, result.outputs.report!), 'a literal <escape> inside')
  const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
  const evidence = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(evidence.stripped, { sources: ['<escape>'] })
})

test('a missing output block fails the attempt and keeps what was found as partial output', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run({ answer: blocks('report') }, ['report', 'sources'])
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /no output block for sources/)
  assert.deepEqual(result.outputs, {})
  assert.equal(await text(artifacts, result.partial!.report!), 'content of report\nsecond line')
  assert.equal(conversationOf(artifacts, result, 'partial').content.parts.length, 2)
})

for (const [name, answer] of [['instead of streaming', ''], ['after some streamed text', 'The answer begins here and then ']] as const) {
  test(`the site's own error answer fails the attempt at once, as a retryable site error (${name})`, { skip, timeout: 60_000 }, async () => {
    const started = Date.now()
    // A long answer clock: failing fast must not be a timeout.
    const { artifacts, result } = await run({ answer, loadFailure: true }, ['report'], { config: { timeouts: { load: 10, answer: 40, stable: 0.5 } } })
    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'site error: the answer did not load (retryable)')
    assert.ok(Date.now() - started < 30_000)
    assert.ok(result.partial?.screenshot)
    assert.ok(result.partial?.snapshot)
    const evidence = JSON.parse(await text(artifacts, result.partial!.evidence!))
    assert.equal(evidence.siteError, true)
    assert.equal(evidence.waitEnded, 'site error')
  })
}

test('an answer that never starts fails at the answer timeout', { skip, timeout: 60_000 }, async () => {
  const { result } = await run({ thinkMs: 60_000 }, ['report'], { config: { timeouts: { load: 10, answer: 2, stable: 0.5 } } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /wait stage timed out after 2 s/)
  assert.ok(result.partial?.screenshot)
})

test('cancel while the answer is awaited stops the attempt', { skip, timeout: 60_000 }, async () => {
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 5000)
  const started = Date.now()
  const { result } = await run({ thinkMs: 60_000 }, ['report'], { signal: stop.signal })
  assert.equal(result.status, 'cancelled')
  assert.ok(Date.now() - started < 20_000)
})

test('the attempt time limit stops a waiting attempt and fails it', { skip, timeout: 60_000 }, async () => {
  const { result } = await run({ thinkMs: 60_000 }, ['report'], { extra: { attemptTimeoutMinutes: 0.05 } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /exceeded its time limit/)
})

test('the profile is created owner-only and reused by the next attempt', { skip, timeout: 60_000 }, async () => {
  const fake = await site({ requireCookie: true })
  const config = web(fake)
  const { artifacts } = memory()
  const worker = webWorker(account(config), artifacts, join(root, 'attempts'))
  for (let i = 0; i < 2; i++) {
    const result = await worker.run(request({ task: await task(artifacts, 'x') }, ['report']))
    assert.equal(result.status, 'failed', 'the fake serves a sign-in wall until the cookie exists')
  }
  assert.equal(statSync(config.profileDir).mode & 0o777, 0o700)
  assert.ok(existsSync(join(config.profileDir, 'Default')), 'one Chrome profile, kept between attempts')
})

test('login imports cookies into the profile, checks the signed-in state and never prints a value', { skip, timeout: 60_000 }, async () => {
  const fake = await site({ requireCookie: true, answer: blocks('report') })
  const config = web(fake)
  const file = JSON.stringify([{ name: 'session', value: 'valid', domain: '127.0.0.1', path: '/' }])
  const report = await webLogin(config, { cookies: file, cookieDomains: ['127.0.0.1'] })
  assert.equal(report.signedIn, true, report.detail)
  assert.doesNotMatch(JSON.stringify(report), /"valid"|session=valid/)
  const { artifacts } = memory()
  const worker = webWorker(account(config), artifacts, join(root, 'attempts'))
  const result = await worker.run(request({ task: await task(artifacts, 'x') }, ['report']))
  assert.equal(result.status, 'succeeded', result.reason)
  const anonymous = await webLogin(web(fake), { cookies: JSON.stringify([{ name: 'other', value: 'z', domain: '127.0.0.1', path: '/' }]), cookieDomains: ['127.0.0.1'] })
  assert.equal(anonymous.signedIn, false)
  assert.match(anonymous.detail, /sign-in wall/)
})

test('manual login needs a display', async () => {
  const fake = await site()
  await assert.rejects(webLogin(web(fake), { display: undefined }), /no display.*--cookies/)
})

