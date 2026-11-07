/**
 * The chatgpt-web Runtime against System 1's local stand-in for chatgpt.com
 * (packages/web-driver/tests/fake-chatgpt.ts): scenarios are options of the fake. Drives
 * the Chrome the Runtime chooses, headed on a private Xvfb; no network and no account. A
 * Chrome that cannot start fails it (test-support/headed.ts). The driver's own page logic
 * is the driver's; these tests are what the Runtime does around it.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Artifacts } from '@system/artifacts'
import { FakeChatGpt, type FakeOptions } from '../../web-driver/tests/fake-chatgpt.ts'
import { CHROME, skipHeaded } from '../../../test-support/headed.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { processSpawner } from '../../../test-support/process.ts'
import { CONVERSATION_KIND, TASK_KIND, conversationSchema, taskSchema, type Conversation, type WorkerRequest, type WorkerResult } from '@system/work'
import { agentWorker, type Account } from '../src/agent.ts'
import { CHROME_ARGS, IGNORED_DEFAULT_ARGS, chromeTmpdir, launch, launchTimeoutMs, parseBlocks, prepareProfile, profileLockPid, singleTab, webAttempt, webDefaults, webPrompt, type WebConfig } from '../src/chatgpt.ts'
import { startXvfb } from '../src/display.ts'
import { parseCookies, webLogin } from '../src/chatgpt-login.ts'

const skip = skipHeaded
const root = mkdtempSync(join(tmpdir(), 'system-chatgpt-'))
const fakes: FakeChatGpt[] = []
/** The fake site with these options, stopped after the file's tests. The clipboard holds the answer's Markdown exactly unless a test says otherwise. */
async function site(options: FakeOptions = {}): Promise<FakeChatGpt> {
  const fake = new FakeChatGpt({ thinkMs: 100, copied: (markdown) => markdown, ...options })
  await fake.start()
  fakes.push(fake)
  return fake
}
after(async () => {
  await Promise.all(fakes.map((fake) => fake.stop()))
  rmSync(root, { recursive: true, force: true })
})

/** An answer that fills each of `slots` with a labelled block, as the prompt asks. */
const blocks = (...slots: string[]) => ['Here is the **answer**.', '', ...slots.flatMap((slot) => ['```' + slot, `content of ${slot}`, 'second line', '```', ''])].join('\n')

let count = 0
const memory = () => memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...CONVERSATION_KIND, content: conversationSchema })

function web(fake: FakeChatGpt, extra: Partial<WebConfig> = {}): WebConfig {
  return { ...webDefaults(join(root, `profile-${count++}`)), url: `${fake.origin}/`, executablePath: CHROME, timeouts: { load: 10, answer: 20, stable: 0.5 }, ...extra }
}
const account = (config: WebConfig, extra: Partial<Account> = {}): Account => ({
  ref: 'chatgpt-web/default', runtime: 'chatgpt-web', capabilities: ['research'], command: CHROME, version: async () => 'fake', web: config, ...extra,
})
function request(inputs: Record<string, string>, outputs: string[], signal = new AbortController().signal): WorkerRequest {
  return { workId: 'work:test', attemptId: `attempt:${count++}`, stepId: 'research', capabilities: ['research'], inputs, outputs, signal }
}
async function task(artifacts: Artifacts, instructions: string, note?: string): Promise<string> {
  const producer = { type: 'operator' as const, ref: 'tester' }
  const context = note === undefined ? [] : [(await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: new TextEncoder().encode(note), mediaType: 'text/plain', classification: 'local-private', producer })).id]
  return (await artifacts.put({ ...TASK_KIND, content: { instructions, ...(context.length ? { context } : {}) }, ...(context.length ? { inputs: context } : {}), classification: 'local-private', producer })).id
}
/** One attempt on a fake site with `options`; `answer` defaults to a block for each of `outputs`. */
async function run(options: FakeOptions = {}, outputs = ['report'], more: { config?: Partial<WebConfig>; signal?: AbortSignal; extra?: Partial<Account>; instructions?: string; note?: string; started?: (fake: FakeChatGpt) => void } = {}) {
  const fake = await site({ answer: blocks(...outputs), ...options })
  more.started?.(fake)
  const { artifacts } = memory()
  const worker = agentWorker(account(web(fake, more.config), more.extra), artifacts, processSpawner, join(root, 'attempts'))
  const result = await worker.run(request({ task: await task(artifacts, more.instructions ?? 'Explain the fake topic.', more.note) }, outputs, more.signal))
  return { artifacts, result, fake }
}
const text = async (artifacts: Artifacts, id: string) => Buffer.from(await artifacts.readBytes(id)).toString('utf8')
const conversationOf = (artifacts: Artifacts, result: WorkerResult, slot: 'outputs' | 'partial' = 'outputs') => {
  const read = artifacts.get(result[slot]!.conversation!)
  if (read.state !== 'stored') throw new Error('not stored')
  return { occurrences: read.occurrences, content: read.envelope.content as Conversation }
}

test('parseBlocks reads labelled fenced blocks, with longer fences around shorter ones', () => {
  const markdown = ['intro', '', '```report', 'a', '```', '', '````sources', '```js', 'x', '```', '````', '', '```other', 'z', '```'].join('\n')
  assert.deepEqual(parseBlocks(markdown, ['report', 'sources', 'missing']), { blocks: { report: 'a', sources: '```js\nx\n```' }, missing: ['missing'] })
})

test('parseBlocks reads a long-fenced block that holds a shorter fence, and only closes it with an equal or longer one', () => {
  const review = '## Verdict\nok\n```ts\nconst a = 1\n```'
  assert.deepEqual(parseBlocks(`\`\`\`\`review\n${review}\n\`\`\`\``, ['review']), { blocks: { review }, missing: [] })
  assert.deepEqual(parseBlocks(`intro\n\`\`\`\`\`review\n${review}\n\`\`\`\`\`\`\n`, ['review']), { blocks: { review }, missing: [] })
  // A bare long fence has no label, so it fills no slot.
  assert.deepEqual(parseBlocks(`\`\`\`\`\n${review}\n\`\`\`\``, ['review']), { blocks: {}, missing: ['review'] })
  // A shorter closing line is content; the block is never closed here.
  assert.deepEqual(parseBlocks('````review\nx\n```', ['review']), { blocks: {}, missing: ['review'] })
})

test('parseBlocks reads tilde fences by CommonMark: backtick code inside never ends one, and a closing fence is as long', () => {
  const review = '## Verdict\nok\n```ts\nconst a = 1\n```\n\n```json\n{"a":1}\n```'
  assert.deepEqual(parseBlocks(`intro\n~~~~review\n${review}\n~~~~\n`, ['review']), { blocks: { review }, missing: [] })
  assert.deepEqual(parseBlocks(`~~~~~review\nx\n~~~~\ny\n~~~~~`, ['review']), { blocks: { review: 'x\n~~~~\ny' }, missing: [] })
  assert.deepEqual(parseBlocks('~~~~review\nx\n~~~', ['review']), { blocks: {}, missing: ['review'] })
  assert.deepEqual(parseBlocks('~~~~review\nx\n````', ['review']), { blocks: {}, missing: ['review'] })
})

test('webPrompt asks for each output in a four-tilde fence and nothing after the last', () => {
  const dir = join(root, 'prompt-fmt')
  mkdirSync(dir, { recursive: true })
  const ws = { root: dir, home: dir, inputs: dir, outputs: dir, work: dir, instructions: 'Review it.', listed: [], context: [] }
  const { header } = webPrompt(ws, request({}, ['report', 'sources']), 4000)
  assert.match(header, /^- report: a line "~~~~report", the output, a line "~~~~"$/m)
  assert.match(header, /^- sources: a line "~~~~sources", the output, a line "~~~~"$/m)
  assert.match(header, /more tildes/)
  assert.match(header, /nothing after the last/i)
  assert.ok(!header.includes('longer fence'))
})

test('parseCookies reads a browser-extension JSON export and a Netscape file, for chatgpt.com only', () => {
  const json = JSON.stringify([
    { name: 's', value: 'v1', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, expirationDate: 1900000000, sameSite: 'no_restriction' },
    { name: 'o', value: 'v2', domain: 'auth.openai.com', path: '/', session: true, sameSite: 'unspecified' },
    { name: 'x', value: 'v3', domain: '.example.org', path: '/' },
  ])
  assert.deepEqual(parseCookies(json), {
    cookies: [
      { name: 's', value: 'v1', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, expires: 1900000000, sameSite: 'None' },
      { name: 'o', value: 'v2', domain: 'auth.openai.com', path: '/', secure: false, httpOnly: false, expires: -1 },
    ],
    skipped: 1,
  })
  const netscape = ['# Netscape HTTP Cookie File', '.chatgpt.com\tTRUE\t/\tTRUE\t1900000000\ts\tv1', '#HttpOnly_.chatgpt.com\tTRUE\t/\tTRUE\t0\th\tv2', '.example.org\tTRUE\t/\tFALSE\t0\tx\tv3'].join('\n')
  assert.deepEqual(parseCookies(netscape), {
    cookies: [
      { name: 's', value: 'v1', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: false, expires: 1900000000 },
      { name: 'h', value: 'v2', domain: '.chatgpt.com', path: '/', secure: true, httpOnly: true, expires: -1 },
    ],
    skipped: 1,
  })
  assert.throws(() => parseCookies('not cookies'), /neither a JSON/)
  assert.throws(() => parseCookies('[]'), /no cookie for chatgpt\.com/)
})

test('Chrome starts when TMPDIR is too deep for its profile socket', { skip, timeout: 60_000 }, async () => {
  // Chrome puts SingletonSocket under TMPDIR and aborts ("Socket path too long") past 107 bytes: a throwaway HOME is that deep.
  const deep = join(root, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40))
  mkdirSync(deep, { recursive: true })
  const was = process.env.TMPDIR
  process.env.TMPDIR = deep
  const fake = await site()
  const display = await startXvfb()
  try {
    const context = await launch(web(fake), display)
    await context.close()
  } finally {
    if (was === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = was
    await display.stop()
  }
})

test('the browser is launched without the flags that advertise automation, and never headless', () => {
  assert.deepEqual([...IGNORED_DEFAULT_ARGS].sort(), ['--enable-automation', '--no-sandbox', '--password-store=basic', '--use-mock-keychain'])
  assert.ok(!CHROME_ARGS.some((arg) => /headless|enable-automation|user-agent/.test(arg)))
})

test('a short TMPDIR is kept, and a deep one is replaced by a short directory owned by the user, mode 0700', () => {
  const was = process.env.TMPDIR
  try {
    process.env.TMPDIR = '/tmp'
    assert.equal(chromeTmpdir(), '/tmp')
    process.env.TMPDIR = join(root, 'x'.repeat(60))
    const short = chromeTmpdir()
    assert.ok(short.length <= 55, short)
    assert.equal(statSync(short).mode & 0o777, 0o700)
  } finally {
    if (was === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = was
  }
})

test('one prompt is sent in a temporary chat in Chat mode, the answer is awaited, and each labelled block fills its slot', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result, fake } = await run({}, ['report', 'sources'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.report!), 'content of report\nsecond line')
  assert.equal(await text(artifacts, result.outputs.sources!), 'content of sources\nsecond line')
  assert.equal(fake.sent.length, 1)
  assert.equal(fake.sent[0]!.temporary, true)
  assert.equal(fake.sent[0]!.mode, 'chat', 'the page started on Work: the driver switched it before anything was typed')
  assert.match(fake.sent[0]!.prompt, /"~~~~report"/)
  assert.equal(result.usage, undefined, 'the web UI shows no token counts')
  assert.deepEqual(result.executor, { ref: 'chatgpt-web/default', account: 'default', command: CHROME, version: 'fake' })
  assert.ok(result.log)
})

test('the exchange is stored as a conversation produced by the Worker, with the page URL, the model read back and temporary-chat context', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run({}, ['report'], { instructions: 'Explain the fake topic.' })
  assert.equal(result.status, 'succeeded', result.reason)
  const { occurrences, content } = conversationOf(artifacts, result)
  assert.deepEqual(occurrences.map((o) => o.producer), [{ type: 'worker', ref: 'chatgpt-web/default' }])
  assert.equal(content.asserted.provider, 'ChatGPT')
  assert.match(content.asserted.url!, /^http:\/\/127\.0\.0\.1:\d+\/c\/[0-9a-f-]{36}\?temporary-chat=true$/, 'the site\'s own address of a temporary chat')
  assert.equal(content.asserted.model, 'Latest', 'the model the page read back as selected')
  assert.deepEqual(content.asserted.context, ['ui-map:2026-10-11', 'temporary-chat'])
  const [prompt, response] = content.parts
  assert.deepEqual([prompt!.role, response!.role], ['prompt', 'response'])
  const sent = await text(artifacts, prompt!.artifact)
  assert.match(sent, /Explain the fake topic\./)
  assert.match(sent, /"~~~~report"/)
  const answer = await text(artifacts, response!.artifact)
  assert.match(answer, /Here is the \*\*answer\*\*\./)
  assert.match(answer, /```report\ncontent of report\nsecond line\n```/)
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
    assert.deepEqual(evidence.stages.map((stage: { stage: string }) => stage.stage), ['launch', 'open', 'auth', 'mode', 'insert', 'attach', 'send', 'wait', 'read', 'close'])
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

test('the prompt of a Task with no inputs, or small ones, stays one part', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result, fake } = await run({ attachOver: 1000 }, ['report'], { note: 'a short note' })
  assert.equal(result.status, 'succeeded', result.reason)
  assert.match(fake.sent[0]!.prompt, /a short note/)
  const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
  const evidence = JSON.parse(line.slice(line.indexOf('{')))
  assert.ok(!evidence.stages.some((stage: { stage: string }) => stage.stage === 'attach'))
  assert.equal(evidence.attach, undefined)
})

test('webPrompt splits a prompt into its header and its fenced body, and keeps a short one whole', async () => {
  const dir = join(root, 'prompt-ws')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'context-1')
  writeFileSync(file, NOTE)
  const ws = { root: dir, home: dir, inputs: dir, outputs: dir, work: dir, instructions: 'Review it.', listed: [], context: [{ name: 'context-1', where: file }] }
  const req = request({}, ['report'])
  const split = webPrompt(ws, req, 4000)
  assert.ok(split.body)
  assert.match(split.header, /^You are a Worker for System/)
  assert.match(split.header, /Review it\./)
  assert.match(split.header, /"~~~~report"/)
  assert.match(split.header, /follow in the same message/, 'the header names the attached inputs')
  assert.ok(!split.header.includes('note 0:'))
  assert.match(split.body, /^\nContext \(read-only\)/)
  assert.ok(split.body.includes('note 199:'))
  assert.equal(split.text, split.header + split.body)
  const small = webPrompt(ws, req, 1_000_000)
  assert.equal(small.body, undefined)
  assert.ok(small.header.includes('note 199:'))
  assert.ok(!small.header.includes('follow in the same message'))
  assert.equal(webPrompt({ ...ws, context: [] }, req, 0).body, undefined)
})

test('a page with no model picker is refused before anything is sent', { skip, timeout: 60_000 }, async () => {
  const { result, fake } = await run({ modelPicker: false })
  assert.equal(result.status, 'failed')
  assert.equal(fake.sent.length, 0)
  assert.ok(result.partial?.screenshot)
})

test('with temporaryChat off the chat is a conversation of the account, bound by its id', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result, fake } = await run({}, ['report'], { config: { temporaryChat: false } })
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(fake.sent[0]!.temporary, false)
  const { content } = conversationOf(artifacts, result)
  assert.match(content.asserted.url!, /\/c\/[0-9a-f-]{36}$/)
  assert.deepEqual(content.asserted.context, ['ui-map:2026-10-11'])
})

test('links inside the answer are kept as an attachment of the conversation', { skip, timeout: 60_000 }, async () => {
  const answer = `${blocks('report')}\nSee [source A](https://example.org/a) and [source B](https://example.org/b?x=1).`
  const { artifacts, result } = await run({ answer })
  assert.equal(result.status, 'succeeded', result.reason)
  const { content } = conversationOf(artifacts, result)
  const links = content.parts.find((p) => p.role === 'attachment')!
  assert.equal(links.name, 'links.json')
  assert.deepEqual(JSON.parse(await text(artifacts, links.artifact)), ['https://example.org/a', 'https://example.org/b?x=1'])
  assert.match(await text(artifacts, content.parts.find((p) => p.role === 'response')!.artifact), /\[source A\]\(https:\/\/example\.org\/a\)/)
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
  for (const [options, reason] of [[{ chatToggleBroken: true }, /mode\.select-chat did not reach its postcondition/], [{ startOnWork: false, workComposer: true }, /refusing to use Work/]] as const) {
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

test('a missing output block fails the attempt and keeps what was found as partial output', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run({ answer: blocks('report') }, ['report', 'sources'])
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /no output block for sources/)
  assert.deepEqual(result.outputs, {})
  assert.equal(await text(artifacts, result.partial!.report!), 'content of report\nsecond line')
  assert.equal(conversationOf(artifacts, result, 'partial').content.parts.length, 2)
})

test('an answer that never starts fails at the answer timeout', { skip, timeout: 60_000 }, async () => {
  const { result } = await run({ thinkMs: 60_000 }, ['report'], { config: { timeouts: { load: 10, answer: 2, stable: 0.5 } } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /answer stage timed out after 2 s/)
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
  const { result } = await run({ thinkMs: 60_000 }, ['report'], { extra: { attemptTimeoutMinutes: 0.1 } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /exceeded its time limit/)
})

test('the profile is created owner-only and reused by the next attempt', { skip, timeout: 60_000 }, async () => {
  const fake = await site({ requireCookie: true })
  const config = web(fake)
  const { artifacts } = memory()
  const worker = agentWorker(account(config), artifacts, processSpawner, join(root, 'attempts'))
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
  const worker = agentWorker(account(config), artifacts, processSpawner, join(root, 'attempts'))
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

// WW1 defect 3: the 1.5 s of `timeouts.load` that this file gives a slow page used to be Chrome's launch timeout too, and failed under load.
test('Chrome gets a launch clock of its own, 30 s unless configured, whatever the page clocks are', () => {
  const defaults = webDefaults(join(root, 'p'))
  assert.equal(launchTimeoutMs(defaults), 30_000)
  assert.equal(launchTimeoutMs({ ...defaults, timeouts: { load: 1.5, answer: 5, stable: 0.5 } }), 30_000, 'the 1.5 s of a page test is not a launch clock')
  assert.equal(launchTimeoutMs({ ...defaults, timeouts: { ...defaults.timeouts, launch: 5 } }), 5000)
})

// WW1 defect 1: a profile that held 14 tabs (5.5 GB) stalled Chrome's launch for the 60 s limit, so restore is prevented before launch.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('before launch the profile is told to open a new tab and its last exit is marked clean; sessions go, the signed-in state stays', () => {
  const dir = join(root, 'prepare')
  const keep = { Cookies: 'cookies', 'Login Data': 'logins', 'Local Storage/leveldb/000003.log': 'ls', 'IndexedDB/https_x/1.ldb': 'idb', 'Session Storage/000003.log': 'ss' }
  for (const [name, data] of Object.entries(keep)) {
    mkdirSync(join(dir, 'Default', name, '..'), { recursive: true })
    writeFileSync(join(dir, 'Default', name), data)
  }
  mkdirSync(join(dir, 'Default', 'Sessions'), { recursive: true })
  writeFileSync(join(dir, 'Default', 'Sessions', 'Session_13'), 'tabs')
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1, startup_urls: ['https://a.test/'] }, profile: { exit_type: 'Crashed', exited_cleanly: false, name: 'kept' }, other: { x: 1 } }))
  prepareProfile(dir)
  const prefs = JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'))
  assert.deepEqual(prefs, { session: { restore_on_startup: 5, startup_urls: ['https://a.test/'] }, profile: { exit_type: 'Normal', exited_cleanly: true, name: 'kept' }, other: { x: 1 } })
  assert.ok(!existsSync(join(dir, 'Default', 'Sessions')))
  for (const [name, data] of Object.entries(keep)) assert.equal(readFileSync(join(dir, 'Default', name), 'utf8'), data, name)
  assert.deepEqual(readdirSync(join(dir, 'Default')).filter((name) => /tmp/i.test(name)), [], 'the atomic write leaves nothing behind')
  prepareProfile(join(root, 'fresh-profile'))
  assert.ok(!existsSync(join(root, 'fresh-profile', 'Default', 'Preferences')), 'a profile with no Preferences yet is left for Chrome to create')
})

test('a profile that a running Chrome holds is left alone', () => {
  const dir = join(root, 'held')
  mkdirSync(join(dir, 'Default', 'Sessions'), { recursive: true })
  symlinkSync(`host-${process.pid}`, join(dir, 'SingletonLock'))
  assert.equal(profileLockPid(dir), process.pid)
  prepareProfile(dir)
  assert.ok(existsSync(join(dir, 'Default', 'Sessions')))
})

for (const end of ['a clean close', 'a SIGKILL'] as const) {
  test(`a profile that held several tabs opens one tab after ${end}, and its session cookie survives a clean one`, { skip, timeout: 120_000 }, async () => {
    const fake = await site()
    const config = web(fake)
    const display = await startXvfb()
    try {
      const first = await launch(config, display)
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
      await sleep(2500)
      assert.deepEqual(second.pages().map((page) => page.url()), ['about:blank'], 'nothing was restored')
      if (end === 'a clean close') assert.ok((await second.cookies(fake.origin)).some((cookie) => cookie.name === 'kept'), 'the session-only cookie is still there')
      await second.close()
    } finally {
      await display.stop()
    }
  })
}

test('the worker tab is opened first, every other page is closed, and a page that arrives late is closed too', { skip, timeout: 60_000 }, async () => {
  const fake = await site()
  const display = await startXvfb()
  try {
    const context = await launch(web(fake), display)
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
    await display.stop()
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

test('an output with no block of its name is filled from the Markdown text, and the evidence says so', { skip, timeout: 120_000 }, async () => {
  // The page's block has no name (`Code`); Copy gives the fence with the name.
  const { artifacts, result } = await run({ answer: '```\nsame words\n```', copied: () => '```report\nsame words\n```' }, ['report'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.report!), 'same words')
  const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
  assert.deepEqual(JSON.parse(line.slice(line.indexOf('{'))).filled, { report: 'text' })
})

test('two rendered blocks with the label of an output are ambiguous: the attempt fails with that reason', { skip, timeout: 120_000 }, async () => {
  const { result } = await run({ answer: '```review\nfirst\n```\n\n```review\nsecond\n```', copied: () => '', codeWidget: true }, ['review'])
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /review.*ambiguous|ambiguous.*review/)
})

// WW5c (live 2026-11-07): a tilde fence is closed only by tildes, so a review holding ```ts and ```json is one block, whole.
for (const [name, options] of [
  ['the rendered block', { copied: () => '', codeWidget: true }],
  ['the Markdown text', { copied: (markdown: string) => markdown }],
] as const) {
  test(`a tilde-fenced review holding code fences fills its output verbatim through ${name}`, { skip, timeout: 120_000 }, async () => {
    const { artifacts, result } = await run({ answer: '~~~~review\n' + REVIEW + '\n~~~~', ...options }, ['review'])
    assert.equal(result.status, 'succeeded', result.reason)
    assert.equal(await text(artifacts, result.outputs.review!), REVIEW)
  })
}

// The real shape: a three-backtick `review` block that its own inner fence closes, the rest of the review after it.
const CUT = '```review\n## 1. Verdict\n\nneeds changes\n\n```ts\nconst before = 1\n```\n\n## 2. Defects\n\n' + 'A long finding about the code that went on after the block closed. '.repeat(8) + '\n\n```json\n{"a":1}\n```'
for (const [name, options] of [
  ['the rendered block', { copied: () => '', codeWidget: true }],
  ['the Markdown text', { copied: (markdown: string) => markdown }],
] as const) {
  test(`an answer that continues outside its output block fails and is kept as partial output (${name})`, { skip, timeout: 120_000 }, async () => {
    const { artifacts, result } = await run({ answer: CUT, ...options }, ['review'])
    assert.equal(result.status, 'failed')
    assert.match(result.reason!, /the answer continues outside its output blocks \(\d+ characters\): an output may be cut short/)
    assert.ok(result.partial!.review, 'what was found is kept')
    assert.equal(await text(artifacts, result.partial!.review!), '## 1. Verdict\n\nneeds changes\n\n```ts\nconst before = 1')
    assert.ok(result.partial!.conversation)
    assert.match(String((await evidenceOf(artifacts, result)).outsideChars), /^\d+$/)
  })
}

test('the outside limit is a setting: a short remark outside the block is fine, and a tighter limit refuses it', { skip, timeout: 120_000 }, async () => {
  const answer = 'Done, here it is.\n\n~~~~review\nthe review\n~~~~'
  const ok = await run({ answer }, ['review'])
  assert.equal(ok.result.status, 'succeeded', ok.result.reason)
  const tight = await run({ answer }, ['review'], { config: { maxOutsideChars: 5 } })
  assert.equal(tight.result.status, 'failed')
  assert.match(tight.result.reason!, /continues outside its output blocks \(14 characters\)/)
})

// The stage chain of one attempt (evidence.ts): written as it happens, kept as partial output, and in the log on success.
const STAGES = ['launch', 'open', 'auth', 'mode', 'insert', 'send', 'wait', 'read', 'close']
const evidenceOf = async (artifacts: Artifacts, result: WorkerResult) => JSON.parse(await text(artifacts, result.partial!.evidence!))

test('a launch that never returns fails at its own clock, and the evidence names the launch stage', { timeout: 30_000 }, async () => {
  const fake = await site()
  const config = web(fake, { timeouts: { load: 10, answer: 20, stable: 0.5, launch: 0.2 } })
  const { artifacts } = memory()
  const result = await webAttempt(account(config), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), () => new Promise(() => {}))
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /launch stage timed out after 0\.2 s/)
  const evidence = await evidenceOf(artifacts, result)
  assert.equal(evidence.launchTimeoutSeconds, 0.2)
  assert.equal(evidence.failedStage, 'launch')
  assert.deepEqual(evidence.stages.map((stage: { stage: string; status: string }) => [stage.stage, stage.status]), [['launch', 'failed'], ['close', 'ok']])
  assert.equal(evidence.promptSubmitted, false)
  assert.equal(evidence.uiMap.revision, '2026-10-11')
  assert.match(evidence.uiMap.hash, /^sha256:/)
})

test('a launch that fails is recorded as such; the record exists before Chrome starts', { timeout: 30_000 }, async () => {
  const fake = await site()
  const { artifacts } = memory()
  const attemptsDir = join(root, 'attempts')
  const req = request({ task: await task(artifacts, 'x') }, ['report'])
  let onDisk: { stages: unknown[]; chrome: string } | undefined
  const result = await webAttempt(account(web(fake)), artifacts, attemptsDir, req, async () => {
    onDisk = JSON.parse(readFileSync(join(attemptsDir, req.attemptId.replace(/[^a-z0-9-]/gi, '_'), 'evidence.json'), 'utf8'))
    throw new Error('Chrome exited\nwith a long log')
  })
  assert.deepEqual(onDisk!.stages.map((stage) => (stage as { stage: string }).stage), ['launch'], 'the launch stage was written before the launch ran')
  assert.equal(onDisk!.chrome, 'fake')
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /Chrome exited/)
  assert.equal((await evidenceOf(artifacts, result)).stages[0].error, 'Chrome exited')
})

test('a good attempt records every stage in order, with times, page counts, viewport and that the prompt was submitted', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run({}, ['report'])
  assert.equal(result.status, 'succeeded', result.reason)
  const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
  const evidence = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(evidence.stages.map((stage: { stage: string; status: string }) => [stage.stage, stage.status]), STAGES.map((stage) => [stage, 'ok']))
  assert.ok(evidence.stages.every((stage: { elapsedMs: number }) => stage.elapsedMs >= 0))
  assert.equal(evidence.promptSubmitted, true)
  assert.equal(evidence.launchTimeoutSeconds, 30)
  assert.equal(evidence.chrome, 'fake')
  assert.ok(evidence.pages.initial >= 1)
  assert.equal(evidence.pages.beforeNavigation, 1)
  assert.ok(evidence.viewport.width > 0 && evidence.viewport.height > 0)
})

test('a failure names its stage and keeps the page as evidence: screenshot, redacted DOM, URL, viewport, map version', { skip, timeout: 60_000 }, async () => {
  const cases = [
    ['auth', { signedIn: false }, {}, false],
    ['mode', { modeSwitch: false }, { timeouts: { load: 10, answer: 20, stable: 0.5, mode: 1 } }, false],
    ['wait', { thinkMs: 60_000 }, { timeouts: { load: 10, answer: 2, stable: 0.5 } }, true],
  ] as const
  for (const [stage, options, config, submitted] of cases) {
    const { artifacts, result } = await run(options, ['report'], { config })
    assert.equal(result.status, 'failed', stage)
    const evidence = await evidenceOf(artifacts, result)
    assert.equal(evidence.failedStage, stage)
    assert.equal(evidence.promptSubmitted, submitted, stage)
    assert.equal(evidence.stages.at(-1).stage, 'close', 'the browser is closed and that is recorded')
    const snapshot = JSON.parse(await text(artifacts, result.partial!.snapshot!))
    assert.match(snapshot.url, /^http:\/\/127\.0\.0\.1:\d+\//)
    assert.ok(snapshot.viewport.width > 0)
    assert.equal(snapshot.uiMap.revision, '2026-10-11')
    assert.ok(snapshot.dom.includes('<'))
    assert.ok(result.partial!.screenshot)
  }
})

test('a cancel and the time limit end Chrome with a close, and leave the evidence as partial output', { skip, timeout: 60_000 }, async () => {
  // Cancel once the page has the prompt, not after a fixed time: under load a fixed delay can come before the send.
  const stop = new AbortController()
  const cancelled = await run({ thinkMs: 60_000 }, ['report'], {
    signal: stop.signal,
    started: (fake) => { const poll = setInterval(() => { if (fake.sent.length) { clearInterval(poll); stop.abort() } }, 50) },
  })
  assert.equal(cancelled.result.status, 'cancelled')
  const timedOut = await run({ thinkMs: 60_000 }, ['report'], { extra: { attemptTimeoutMinutes: 0.1 } })
  assert.equal(timedOut.result.status, 'failed')
  for (const { artifacts, result, fake } of [cancelled, timedOut]) {
    const evidence = await evidenceOf(artifacts, result)
    assert.equal(evidence.stages.find((stage: { stage: string }) => stage.stage === 'close').status, 'ok')
    // The record says what the page received: the time limit may come before or after the send.
    if (fake.sent.length) assert.equal(evidence.promptSendAttempted, true)
    if (evidence.promptSubmitted) assert.ok(fake.sent.length > 0)
  }
  assert.equal(cancelled.fake.sent.length, 1)
})

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** A stand-in for a Chrome the launcher started: a process of its own group that holds the profile's lock, as Chrome's SingletonLock does. */
function standInChrome(profileDir: string): number {
  const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
  child.unref()
  mkdirSync(profileDir, { recursive: true })
  symlinkSync(`host-${child.pid}`, join(profileDir, 'SingletonLock'))
  return child.pid!
}

test('a launch that times out leaves no Chrome running: the process group it started is killed', { timeout: 30_000 }, async () => {
  const fake = await site()
  const config = web(fake, { timeouts: { load: 10, answer: 20, stable: 0.5, launch: 0.2 } })
  const { artifacts } = memory()
  let chrome = 0
  try {
    const result = await webAttempt(account(config), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), () => { chrome = standInChrome(config.profileDir); return new Promise(() => {}) })
    assert.equal(result.status, 'failed')
    assert.match(result.reason!, /launch stage timed out/)
    await sleep(200)
    assert.ok(!alive(chrome), 'the Chrome of the abandoned launch is gone')
  } finally {
    try { process.kill(chrome, 'SIGKILL') } catch { /* gone */ }
  }
})

test('a profile that another live Chrome holds is never launched, and that Chrome is left alone', { timeout: 30_000 }, async () => {
  const config = webDefaults(join(root, 'profile-held'))
  mkdirSync(config.profileDir, { recursive: true })
  symlinkSync(`host-${process.pid}`, join(config.profileDir, 'SingletonLock'))
  await assert.rejects(launch(config, undefined as never), new RegExp(`held by a running Chrome \\(pid ${process.pid}\\)`))
  const fake = await site()
  const { artifacts } = memory()
  const held = web(fake)
  const chrome = standInChrome(held.profileDir)
  try {
    const result = await webAttempt(account(held), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']))
    assert.equal(result.status, 'failed')
    assert.match(result.reason!, /held by a running Chrome/)
    assert.ok(alive(chrome), 'the other Chrome was not touched')
  } finally {
    process.kill(chrome, 'SIGKILL')
  }
})

test('the close stage is ok only when the browser process has exited', { timeout: 30_000 }, async () => {
  const fake = await site()
  const config = web(fake)
  const { artifacts } = memory()
  let chrome = 0
  // A context whose close() returns while its process lives on.
  const context = { close: async () => {}, pages: () => [], on: () => {}, newPage: async () => { throw new Error('no page') } }
  try {
    const result = await webAttempt(account(config), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), async () => { chrome = standInChrome(config.profileDir); return context as never })
    assert.equal(result.status, 'failed')
    const evidence = await evidenceOf(artifacts, result)
    const close = evidence.stages.find((stage: { stage: string }) => stage.stage === 'close')
    assert.equal(close.status, 'failed')
    assert.match(close.error, /did not exit/)
    await sleep(200)
    assert.ok(!alive(chrome), 'the browser that outlived close() was killed')
  } finally {
    try { process.kill(chrome, 'SIGKILL') } catch { /* gone */ }
  }
})

test('a send is an attempt first and a submission only once the page shows the user turn', { skip, timeout: 60_000 }, async () => {
  const good = await run()
  const line = (await text(good.artifacts, good.result.log!)).trim().split('\n').at(-1)!
  const evidence = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual([evidence.promptSendAttempted, evidence.promptSubmitted], [true, true])
  // A launch that fails before any send: neither is claimed.
  const fake = await site()
  const { artifacts } = memory()
  const failed = await webAttempt(account(web(fake)), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), async () => { throw new Error('no chrome') })
  const before = await evidenceOf(artifacts, failed)
  assert.deepEqual([before.promptSendAttempted, before.promptSubmitted], [false, false])
})

test('a page that cannot be closed breaks the one-tab invariant loudly, and a late page counts only once closed', async () => {
  const stuck = { close: async () => { throw new Error('stuck') } }
  const context = { pages: () => [stuck], newPage: async () => ({ close: async () => {} }), on: () => {} }
  await assert.rejects(singleTab(context as never), /1 other page\(s\) could not be closed/)
})
