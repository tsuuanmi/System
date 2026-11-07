/**
 * The remote sign-in and the private display (PROP-0005), against the local
 * fake ChatGPT page: `startRemoteLogin` serves the viewer, forwards input and
 * saves; an attempt runs headed on its own Xvfb. No network and no account.
 * Skipped without Xvfb or Chrome. Every test stops what it starts.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { processSpawner } from '../../../test-support/process.ts'
import { TASK_KIND, CONVERSATION_KIND, conversationSchema, taskSchema, type WorkerRequest } from '@system/work'
import { agentWorker, type Account } from '../src/agent.ts'
import { profileLockPid, webDefaults, type WebConfig } from '../src/chatgpt.ts'
import { findXvfb } from '../src/display.ts'
import { startRemoteLogin, type RemoteSession } from '../src/remote-login.ts'

const CHROME = '/usr/bin/google-chrome'
const skip = (!existsSync(CHROME) && `${CHROME} is not installed`) || (!findXvfb() && 'Xvfb is not installed')
const pages = join(dirname(fileURLToPath(import.meta.url)), 'fake-chatgpt')
const root = mkdtempSync(join(tmpdir(), 'system-remote-'))
const events: Record<string, any>[] = []
let server: Server
let base = ''
before(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/event') {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => { events.push(JSON.parse(body)); res.end() })
      return
    }
    const file = req.url?.startsWith('/chat.js') ? 'chat.js' : 'index.html'
    res.setHeader('content-type', file === 'chat.js' ? 'text/javascript' : 'text/html')
    res.end(readFileSync(join(pages, file)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})
after(() => {
  server.closeAllConnections()
  server.close()
  rmSync(root, { recursive: true, force: true })
})

let count = 0
function web(query: string, extra: Partial<WebConfig> = {}): WebConfig {
  return { ...webDefaults(join(root, `profile-${count++}`)), url: `${base}?${query}`, executablePath: CHROME, timeouts: { load: 10, send: 10, answer: 20, stable: 0.5 }, ...extra }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers })
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Run a test with a session and always stop it, with the browser and display it started. */
async function withSession(config: WebConfig, run: (s: RemoteSession, pids: { chrome: number }) => Promise<void>, options: { ttlMs?: number } = {}) {
  const session = await startRemoteLogin(config, options)
  try {
    await until('the page to load', () => events.some((e) => e.type === 'load' && e.scenario === 'remote'))
    await run(session, { chrome: profileLockPid(config.profileDir)! })
  } finally {
    await session.cancel()
    await session.done
  }
}
const gone = (session: RemoteSession, chrome: number) => {
  assert.equal(alive(session.xvfbPid), false, 'Xvfb is still running')
  assert.equal(alive(chrome), false, 'the browser is still running')
}

test('--remote serves the viewer behind a 32-byte token, and says how to reach it', { skip, timeout: 60_000 }, async () => {
  await withSession(web('scenario=remote'), async (session) => {
    const url = new URL(session.url)
    assert.equal(url.hostname, '127.0.0.1')
    assert.match(url.pathname, /^\/[0-9a-f]{64}\/$/)
    assert.equal(session.ssh, `ssh -L ${url.port}:127.0.0.1:${url.port} ${session.sshTarget}`)
    const page = await get(session.url)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /Save/)
    assert.match(html, /Cancel/)
    for (const path of ['/', '/events', '/input', '/save', `/${'0'.repeat(64)}/`, `/${'0'.repeat(64)}/events`]) {
      assert.equal((await get(`${url.origin}${path}`)).status, 403, path)
    }
    assert.equal((await post(`${url.origin}/input`, { type: 'key' })).status, 403)
    assert.equal((await post(`${url.origin}/${'0'.repeat(64)}/save`, {})).status, 403)
    assert.equal((await get(`${session.url}nope`)).status, 404)
  })
})

test('a screencast frame of the tab arrives over server-sent events', { skip, timeout: 60_000 }, async () => {
  await withSession(web('scenario=remote'), async (session) => {
    const response = await get(`${session.url}events`)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    const reader = response.body!.getReader()
    let text = ''
    for (const end = Date.now() + 15_000; !text.includes('\n\n') && Date.now() < end;) text += Buffer.from((await reader.read()).value!).toString()
    await reader.cancel()
    const frame = JSON.parse(/^data: (.*)$/m.exec(text)![1]!) as { data: string; width: number; height: number }
    assert.equal(Buffer.from(frame.data, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff', 'a JPEG')
    assert.ok(frame.width > 0 && frame.height > 0)
  })
})

test('a POSTed click reaches the page, a keystroke reaches it, and a malformed input is refused', { skip, timeout: 60_000 }, async () => {
  events.length = 0
  await withSession(web('scenario=remote'), async (session) => {
    await until('the page to load', () => events.some((e) => e.type === 'load'))
    for (const type of ['mousePressed', 'mouseReleased']) {
      assert.equal((await post(`${session.url}input`, { type: 'mouse', kind: type, x: 300, y: 400, button: 'left', clickCount: 1 })).status, 204)
    }
    await until('the click to arrive', () => events.some((e) => e.type === 'click' && e.x === 300 && e.y === 400))
    assert.equal((await post(`${session.url}input`, { type: 'key', kind: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })).status, 204)
    await until('the key to arrive', () => events.some((e) => e.type === 'key' && e.key === 'a'))
    assert.equal((await post(`${session.url}input`, { type: 'mouse', kind: 'explode', x: 'far' })).status, 400)
    assert.equal((await post(`${session.url}input`, { type: 'eval', expression: '1' })).status, 400)
  })
})

test('a click on the viewer lands where the operator pointed, at any scale', { skip, timeout: 90_000 }, async () => {
  events.length = 0
  await withSession(web('scenario=remote'), async (session) => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true })
    try {
      // A small window makes the canvas smaller than the page, so the click has to be scaled.
      const viewer = await (await browser.newContext({ viewport: { width: 700, height: 500 } })).newPage()
      await viewer.goto(session.url)
      await viewer.waitForFunction(`(() => { const c = document.querySelector('canvas'); return c && c.width > 0 })()`)
      const box = (await viewer.evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cw: document.querySelector('canvas').width, ch: document.querySelector('canvas').height } })()`)) as { x: number; y: number; w: number; h: number; cw: number; ch: number }
      assert.ok(box.w < box.cw, 'the viewer is scaled down')
      events.length = 0
      await viewer.mouse.click(box.x + box.w / 2, box.y + box.h / 4)
      await until('the click to arrive', () => events.some((e) => e.type === 'click'))
      const click = events.find((e) => e.type === 'click')!
      assert.ok(Math.abs(click.x - box.cw / 2) <= 2 && Math.abs(click.y - box.ch / 4) <= 2, `clicked (${click.x}, ${click.y}), wanted about (${box.cw / 2}, ${box.ch / 4})`)
    } finally {
      await browser.close()
    }
  })
})

test('Save closes the browser cleanly, keeps the session in the profile and reports the signed-in state', { skip, timeout: 90_000 }, async () => {
  events.length = 0
  const config = web('scenario=remote')
  const session = await startRemoteLogin(config)
  let chrome = 0
  try {
    await until('the page to load', () => events.some((e) => e.type === 'load'))
    chrome = profileLockPid(config.profileDir)!
    assert.ok(chrome)
    const frames = await get(`${session.url}events`)
    await frames.body!.cancel()
    // The Log in button, top left, sets the session cookie the way the real sign-in sets its own.
    await post(`${session.url}input`, { type: 'mouse', kind: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 })
    await post(`${session.url}input`, { type: 'mouse', kind: 'mouseReleased', x: 20, y: 20, button: 'left', clickCount: 1 })
    await until('the click to arrive', () => events.some((e) => e.type === 'click' && e.id === 'login'))
    const saved = await post(`${session.url}save`, {})
    assert.equal(saved.status, 200)
    assert.deepEqual(await saved.json(), { signedIn: true, detail: 'signed in' })
    assert.deepEqual(await session.done, { signedIn: true, detail: 'signed in' })
    gone(session, chrome)
    await assert.rejects(get(session.url), 'the server is closed')
    assert.equal(existsSync(join(config.profileDir, 'SingletonLock')), false, 'the profile is released')
    assert.equal(readdirSync('/tmp/.X11-unix').includes(`X${session.display.slice(1)}`), false, 'the X socket is removed')
  } finally {
    await session.cancel()
    await session.done
  }
})

test('Cancel ends the session without a sign-in, and cleans up', { skip, timeout: 60_000 }, async () => {
  events.length = 0
  const config = web('scenario=remote')
  const session = await startRemoteLogin(config)
  await until('the page to load', () => events.some((e) => e.type === 'load'))
  const chrome = profileLockPid(config.profileDir)!
  try {
    assert.equal((await post(`${session.url}cancel`, {})).status, 200)
    const report = await session.done
    assert.equal(report.signedIn, false)
    assert.match(report.detail, /cancelled/)
    gone(session, chrome)
  } finally {
    await session.cancel()
    await session.done
  }
})

test('the session expires after its time, and Xvfb, the browser and the server are gone', { skip, timeout: 60_000 }, async () => {
  events.length = 0
  const config = web('scenario=remote')
  const session = await startRemoteLogin(config, { ttlMs: 2500 })
  try {
    await until('the page to load', () => events.some((e) => e.type === 'load'))
    const chrome = profileLockPid(config.profileDir)!
    assert.ok(session.expiresAt > Date.now())
    const report = await session.done
    assert.equal(report.signedIn, false)
    assert.match(report.detail, /expired/)
    gone(session, chrome)
    await assert.rejects(get(session.url))
  } finally {
    await session.cancel()
    await session.done
  }
})

test('an attempt runs a headed browser on its own Xvfb, and stops it afterwards', { skip, timeout: 60_000 }, async () => {
  events.length = 0
  const was = process.env.DISPLAY
  delete process.env.DISPLAY
  try {
    const config = web('scenario=forever')
    const account: Account = { ref: 'chatgpt-web/default', runtime: 'chatgpt-web', capabilities: ['research'], command: CHROME, version: async () => 'fake', web: config }
    const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...CONVERSATION_KIND, content: conversationSchema })
    const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'x' }, classification: 'local-private', producer: { type: 'operator', ref: 'tester' } })).id
    const stop = new AbortController()
    const request: WorkerRequest = { workId: 'work:test', attemptId: 'attempt:display', stepId: 'research', capabilities: ['research'], inputs: { task }, outputs: ['report'], signal: stop.signal }
    const running = agentWorker(account, artifacts, processSpawner, join(root, 'attempts')).run(request)
    await until('the page to load', () => events.some((e) => e.type === 'load' && e.scenario === 'forever'))
    const chrome = profileLockPid(config.profileDir)!
    const env = readFileSync(`/proc/${chrome}/environ`, 'utf8').split('\0')
    const display = env.find((e) => e.startsWith('DISPLAY='))!.slice('DISPLAY='.length)
    assert.match(display, /^:\d+$/, 'the browser runs on a private display')
    assert.ok(existsSync(`/tmp/.X11-unix/X${display.slice(1)}`), 'the display is up')
    assert.doesNotMatch(readFileSync(`/proc/${chrome}/cmdline`, 'utf8'), /--headless/)
    assert.doesNotMatch(events.find((e) => e.type === 'load')!.ua, /Headless/)
    const xvfb = execFileSync('pgrep', ['-f', `Xvfb ${display} `], { encoding: 'utf8' }).trim().split('\n').map(Number)
    assert.equal(xvfb.length, 1)
    stop.abort()
    assert.equal((await running).status, 'cancelled')
    await until('Xvfb to stop', () => !alive(xvfb[0]!), 5000)
    assert.equal(existsSync(`/tmp/.X11-unix/X${display.slice(1)}`), false)
    assert.equal(alive(chrome), false)
  } finally {
    if (was !== undefined) process.env.DISPLAY = was
  }
})
