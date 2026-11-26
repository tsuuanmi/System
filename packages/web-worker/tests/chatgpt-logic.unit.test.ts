/**
 * Pure logic of the chatgpt Worker: block parsing, prompts, cookies, launch flags and clocks, profile preparation.
 * None of these starts Chrome, Xvfb or a Host, so they run in the unit run; the tests that do are in chatgpt-{a,b,c}.test.ts
 * (web-3a: moved from chatgpt-a.test.ts and chatgpt-b.test.ts, unchanged).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { WorkerRequest } from '@system/work'
import { CHROME_ARGS, IGNORED_DEFAULT_ARGS, chromeTmpdir, launchTimeoutMs, parseBlocks, prepareProfile, stripLanguageLabel, stripLeaked, unblocked, profileLockPid, webDefaults, webPrompt } from '../src/chatgpt.ts'
import { parseCookies } from '../src/chatgpt-login.ts'

const root = mkdtempSync(join(tmpdir(), 'system-chatgpt-logic-'))
after(() => rmSync(root, { recursive: true, force: true }))

const request = (inputs: Record<string, string>, outputs: string[]): WorkerRequest => ({ workId: 'work:test', attemptId: 'attempt:0', stepId: 'research', capabilities: ['research'], inputs, outputs, signal: new AbortController().signal })

const NOTE = `Notes of the review:\n${Array.from({ length: 200 }, (_, i) => `note ${i}: the quick brown fox jumps over the lazy dog`).join('\n')}`

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

// The shape of work:bbbf12bc's `sources` output (web-1): an empty line, the block's header label, an empty line, the object.
const SOURCES_WITH_LABEL = '\nJSON\n\n{"sources": [{"id": "s1", "url": "https://example.org/a", "title": "A"}]}'

test('stripLanguageLabel drops a leading language label line before valid JSON, and nothing else (web-1)', () => {
  const stored = stripLanguageLabel(SOURCES_WITH_LABEL)
  assert.equal(stored, '{"sources": [{"id": "s1", "url": "https://example.org/a", "title": "A"}]}')
  assert.doesNotThrow(() => JSON.parse(stored))
  assert.equal(stripLanguageLabel('json\n{"a": 1}'), '{"a": 1}')
  assert.equal(stripLanguageLabel('{"a": 1}'), '{"a": 1}')
  assert.equal(stripLanguageLabel('JSON\nnot json'), 'JSON\nnot json')
  assert.equal(stripLanguageLabel('# Report\n\nbody'), '# Report\n\nbody')
  assert.equal(stripLanguageLabel('Sources\n{"a": 1}'), 'Sources\n{"a": 1}')
})

test('stripLeaked removes a listed token at the very start or end of an output, repeatedly, and never inside it', () => {
  assert.deepEqual(stripLeaked('<escape>{"a": 1}', ['<escape>']), { content: '{"a": 1}', removed: ['<escape>'] })
  assert.deepEqual(stripLeaked('<escape>\n<escape>{"a": 1}\n<escape>', ['<escape>']), { content: '{"a": 1}', removed: ['<escape>', '<escape>', '<escape>'] })
  assert.deepEqual(stripLeaked('first <escape> last', ['<escape>']), { content: 'first <escape> last', removed: [] })
  assert.deepEqual(stripLeaked('<escape>x <escape> y', ['<escape>']), { content: 'x <escape> y', removed: ['<escape>'] })
  // Live on second, 2026-11-08 (canary work:7fb04a70, work:8d9e3c45): the JSON ended in a closing form of the token.
  assert.deepEqual(stripLeaked('{"a": 1}</escape>', ['<escape>', '</escape>']), { content: '{"a": 1}', removed: ['</escape>'] })
  assert.deepEqual(stripLeaked(' a\n', ['<escape>']), { content: ' a\n', removed: [] })
  assert.deepEqual(stripLeaked('<escape>x', []), { content: '<escape>x', removed: [] })
})

test('unblocked counts the page text outside the label and the code of the blocks that fill outputs', () => {
  const text = 'Done, here it is.\nreview\nthe review\nAnd a closing remark.'
  assert.equal(unblocked(text, [{ label: 'review', code: 'the review' }]), 'Done,hereitis.Andaclosingremark.'.length)
  assert.equal(unblocked(text, []), text.replace(/\s/g, '').length)
  // A label that is not shown, or code that is not in the text, takes nothing out.
  assert.equal(unblocked('x y', [{ label: '', code: 'y' }]), 1)
  assert.equal(unblocked('x y', [{ label: 'a', code: 'nope' }]), 2)
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

test('webPrompt splits a prompt into its header and its fenced body, and keeps a short one whole', async () => {
  const dir = join(root, 'prompt-ws')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'context-1')
  writeFileSync(file, NOTE)
  const ws = { root: dir, home: dir, inputs: dir, outputs: dir, work: dir, instructions: 'Review it.', listed: [], context: [{ name: 'context-1', where: file, artifact: `sha256:${'a'.repeat(64)}`, kind: 'file@1' }] }
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

// WW1 defect 3: the 1.5 s of `timeouts.load` that this file gives a slow page used to be Chrome's launch timeout too, and failed under load.
test('Chrome gets a launch clock of its own, 30 s unless configured, whatever the page clocks are', () => {
  const defaults = webDefaults(join(root, 'p'))
  assert.equal(launchTimeoutMs(defaults), 30_000)
  assert.equal(launchTimeoutMs({ ...defaults, timeouts: { load: 1.5, answer: 5, stable: 0.5 } }), 30_000, 'the 1.5 s of a page test is not a launch clock')
  assert.equal(launchTimeoutMs({ ...defaults, timeouts: { ...defaults.timeouts, launch: 5 } }), 5000)
})

// WW1 defect 1: a profile that held 14 tabs (5.5 GB) stalled Chrome's launch for the 60 s limit, so restore is prevented before launch.

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
