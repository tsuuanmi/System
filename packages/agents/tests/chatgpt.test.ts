/**
 * The chatgpt-web Runtime against a local fake ChatGPT page (tests/fake-chatgpt):
 * the same selector roles, scenarios chosen by the query string. Drives the
 * installed Chrome headless; no network and no account. Skipped without Chrome.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Artifacts } from '@system/artifacts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { processSpawner } from '../../../test-support/process.ts'
import { CONVERSATION_KIND, TASK_KIND, conversationSchema, taskSchema, type Conversation, type WorkerRequest, type WorkerResult } from '@system/work'
import { agentWorker, type Account } from '../src/agent.ts'
import { SELECTORS, parseBlocks, parseCookies, webDefaults, webLogin, type WebConfig } from '../src/chatgpt.ts'

const CHROME = '/usr/bin/google-chrome'
const skip = !existsSync(CHROME) && `${CHROME} is not installed`
const pages = join(dirname(fileURLToPath(import.meta.url)), 'fake-chatgpt')
const root = mkdtempSync(join(tmpdir(), 'system-chatgpt-'))
let server: Server
let base = ''
before(async () => {
  server = createServer((req, res) => {
    const file = req.url?.startsWith('/chat.js') ? 'chat.js' : 'index.html'
    res.setHeader('content-type', file === 'chat.js' ? 'text/javascript' : 'text/html')
    res.end(readFileSync(join(pages, file)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})
after(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

let count = 0
const memory = () => memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...CONVERSATION_KIND, content: conversationSchema })

function web(query: string, extra: Partial<WebConfig> = {}): WebConfig {
  return { ...webDefaults(join(root, `profile-${count++}`)), url: `${base}?${query}`, executablePath: CHROME, timeouts: { load: 10, send: 10, answer: 20, stable: 0.5 }, ...extra }
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
async function run(query: string, outputs = ['report'], options: { config?: Partial<WebConfig>; signal?: AbortSignal; extra?: Partial<Account>; instructions?: string } = {}) {
  const { artifacts } = memory()
  const worker = agentWorker(account(web(query, options.config), options.extra), artifacts, processSpawner, join(root, 'attempts'))
  const result = await worker.run(request({ task: await task(artifacts, options.instructions ?? 'Explain the fake topic.') }, outputs, options.signal))
  return { artifacts, result }
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

test('the selector table is versioned', () => {
  assert.equal(typeof SELECTORS.version, 'number')
})

test('one prompt is sent, the answer is awaited, and each labelled block fills its slot', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run('slots=report,sources', ['report', 'sources'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.report!), 'content of report\nsecond line')
  assert.equal(await text(artifacts, result.outputs.sources!), 'content of sources\nsecond line')
  assert.equal(result.usage, undefined, 'the web UI shows no token counts')
  assert.deepEqual(result.executor, { ref: 'chatgpt-web/default', account: 'default', command: CHROME, version: 'fake' })
  assert.ok(result.log)
})

test('the exchange is stored as a conversation produced by the Worker, with the page URL and temporary-chat context', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run('slots=report', ['report'], { instructions: 'Explain the fake topic.' })
  assert.equal(result.status, 'succeeded', result.reason)
  const { occurrences, content } = conversationOf(artifacts, result)
  assert.deepEqual(occurrences.map((o) => o.producer), [{ type: 'worker', ref: 'chatgpt-web/default' }])
  assert.equal(content.asserted.provider, 'ChatGPT')
  assert.match(content.asserted.url!, /^http:\/\/127\.0\.0\.1:\d+\/\?slots=report&temporary-chat=true$/)
  assert.equal(content.asserted.model, 'Fake GPT 5', 'the label the page showed')
  assert.deepEqual(content.asserted.context, [`selectors:${SELECTORS.version}`, 'temporary-chat'])
  const [prompt, response] = content.parts
  assert.deepEqual([prompt!.role, response!.role], ['prompt', 'response'])
  const sent = await text(artifacts, prompt!.artifact)
  assert.match(sent, /Explain the fake topic\./)
  assert.match(sent, /```report/)
  const answer = await text(artifacts, response!.artifact)
  assert.match(answer, /Here is the \*\*answer\*\*\./)
  assert.match(answer, /```report\ncontent of report\nsecond line\n```/)
})

test('a page that shows no model label asserts no model', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run('slots=report&model=none')
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(conversationOf(artifacts, result).content.asserted.model, undefined)
})

test('with temporaryChat off the URL is not marked and only the selector version is asserted as context', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run('slots=report', ['report'], { config: { temporaryChat: false } })
  assert.equal(result.status, 'succeeded', result.reason)
  const { content } = conversationOf(artifacts, result)
  assert.doesNotMatch(content.asserted.url!, /temporary-chat/)
  assert.deepEqual(content.asserted.context, [`selectors:${SELECTORS.version}`])
})

test('a copy action that appears late is waited for', { skip, timeout: 60_000 }, async () => {
  const started = Date.now()
  const { result } = await run('scenario=late-copy', ['report'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.ok(Date.now() - started >= 1500, 'finished before the copy action appeared')
})

test('text that keeps streaming after the copy action appeared is waited out until stable', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run('scenario=early-copy&slots=a,b,c&delay=250', ['a', 'b', 'c'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(await text(artifacts, result.outputs.c!), 'content of c\nsecond line')
})

test('links inside the answer are kept as an attachment of the conversation', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run('scenario=links', ['report'])
  assert.equal(result.status, 'succeeded', result.reason)
  const { content } = conversationOf(artifacts, result)
  const links = content.parts.find((p) => p.role === 'attachment')!
  assert.equal(links.name, 'links.json')
  assert.deepEqual(JSON.parse(await text(artifacts, links.artifact)), ['https://example.org/a', 'https://example.org/b?x=1'])
  assert.match(await text(artifacts, content.parts.find((p) => p.role === 'response')!.artifact), /\[source A\]\(https:\/\/example\.org\/a\)/)
})

test('a sign-in wall fails the attempt with a screenshot as partial output', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run('scenario=signin')
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /sign-in wall/)
  assert.deepEqual(result.outputs, {})
  assert.deepEqual([...(await artifacts.readBytes(result.partial!.screenshot!)).slice(1, 4)], [...Buffer.from('PNG')])
})

test('a CAPTCHA or Cloudflare challenge fails the attempt and is never typed into', { skip, timeout: 60_000 }, async () => {
  const { result } = await run('scenario=captcha')
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /CAPTCHA or Cloudflare challenge/)
  assert.ok(result.partial?.screenshot)
})

test('an unknown page state fails when the load stage times out', { skip, timeout: 60_000 }, async () => {
  const { result } = await run('scenario=blank', ['report'], { config: { timeouts: { load: 1.5, send: 5, answer: 5, stable: 0.5 } } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /unknown page state/)
  assert.ok(result.partial?.screenshot)
})

test('a missing output block fails the attempt and keeps what was found as partial output', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run('slots=report,sources&omit=sources', ['report', 'sources'])
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /no output block for sources/)
  assert.deepEqual(result.outputs, {})
  assert.equal(await text(artifacts, result.partial!.report!), 'content of report\nsecond line')
  assert.equal(conversationOf(artifacts, result, 'partial').content.parts.length, 2)
})

test('an answer that never completes fails at the answer timeout', { skip, timeout: 60_000 }, async () => {
  const { result } = await run('scenario=forever', ['report'], { config: { timeouts: { load: 10, send: 10, answer: 2, stable: 0.5 } } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /answer did not complete within 2 s/)
  assert.ok(result.partial?.screenshot)
})

test('cancel while the answer streams stops the attempt', { skip, timeout: 60_000 }, async () => {
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 3000)
  const started = Date.now()
  const { result } = await run('scenario=forever', ['report'], { signal: stop.signal })
  assert.equal(result.status, 'cancelled')
  assert.ok(Date.now() - started < 15_000)
})

test('the attempt time limit stops a streaming answer and fails the attempt', { skip, timeout: 60_000 }, async () => {
  const { result } = await run('scenario=forever', ['report'], { extra: { attemptTimeoutMinutes: 0.05 } })
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /exceeded its time limit/)
})

test('the profile is created owner-only and reused by the next attempt', { skip, timeout: 60_000 }, async () => {
  const config = web('scenario=session')
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
  const config = web('scenario=session')
  const file = JSON.stringify([{ name: 'session', value: 'ok', domain: '127.0.0.1', path: '/' }])
  const report = await webLogin(config, { cookies: file, cookieDomains: ['127.0.0.1'] })
  assert.equal(report.signedIn, true, report.detail)
  assert.doesNotMatch(JSON.stringify(report), /"ok"|session=ok/)
  const { artifacts } = memory()
  const worker = agentWorker(account(config), artifacts, processSpawner, join(root, 'attempts'))
  const result = await worker.run(request({ task: await task(artifacts, 'x') }, ['report']))
  assert.equal(result.status, 'succeeded', result.reason)
  const anonymous = await webLogin(web('scenario=session'), { cookies: JSON.stringify([{ name: 'other', value: 'z', domain: '127.0.0.1', path: '/' }]), cookieDomains: ['127.0.0.1'] })
  assert.equal(anonymous.signedIn, false)
  assert.match(anonymous.detail, /sign-in wall/)
})

test('manual login needs a display', async () => {
  await assert.rejects(webLogin(web('scenario=session'), { display: undefined }), /no display.*--cookies/)
})
