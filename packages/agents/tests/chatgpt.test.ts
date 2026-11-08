/**
 * The chatgpt-web Runtime against System 1's local stand-in for chatgpt.com
 * (packages/web-driver/tests/fake-chatgpt.ts): scenarios are options of the fake. Drives
 * the Chrome the Runtime chooses, headed on a private Xvfb; no network and no account. A
 * Chrome that cannot start fails it (test-support/headed.ts). The driver's own page logic
 * is the driver's; these tests are what the Runtime does around it.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
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
import { CHROME_ARGS, IGNORED_DEFAULT_ARGS, chromeTmpdir, launch, parseBlocks, webDefaults, type WebConfig } from '../src/chatgpt.ts'
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
async function task(artifacts: Artifacts, instructions: string): Promise<string> {
  return (await artifacts.put({ ...TASK_KIND, content: { instructions }, classification: 'local-private', producer: { type: 'operator', ref: 'tester' } })).id
}
/** One attempt on a fake site with `options`; `answer` defaults to a block for each of `outputs`. */
async function run(options: FakeOptions = {}, outputs = ['report'], more: { config?: Partial<WebConfig>; signal?: AbortSignal; extra?: Partial<Account>; instructions?: string } = {}) {
  const fake = await site({ answer: blocks(...outputs), ...options })
  const { artifacts } = memory()
  const worker = agentWorker(account(web(fake, more.config), more.extra), artifacts, processSpawner, join(root, 'attempts'))
  const result = await worker.run(request({ task: await task(artifacts, more.instructions ?? 'Explain the fake topic.') }, outputs, more.signal))
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
  assert.match(fake.sent[0]!.prompt, /```report/)
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
  assert.match(sent, /```report/)
  const answer = await text(artifacts, response!.artifact)
  assert.match(answer, /Here is the \*\*answer\*\*\./)
  assert.match(answer, /```report\ncontent of report\nsecond line\n```/)
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
