/**
 * The remote sign-in and the private display (PROP-0005), against the local
 * fake ChatGPT page: `startRemoteLogin` serves noVNC over a real Xvfb and VNC
 * server (x11vnc or x0vncserver; skipped, with that as the reason, where there
 * is none), the WebSocket reaches the VNC socket, real pointer input arrives
 * in the page, Save, Cancel and expiry; an attempt runs headed on its own Xvfb.
 * No network and no account. A headed Chrome that cannot start fails it (test-support/headed.ts). Every test stops what it starts.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FakeChatGpt } from '../../web-driver/tests/fake-chatgpt.ts'
import { CHROME, skipHeaded } from '../../../test-support/headed.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { TASK_KIND, CONVERSATION_KIND, conversationSchema, taskSchema, type WorkerRequest } from '@system/work'
import { profileLockPid, webDefaults, webWorker, type WebAccount, type WebConfig } from '../src/chatgpt.ts'
import { apply } from '../src/index.ts'
import { startXvfb, findXvfb, findVnc } from '../src/display.ts'
import { startRemoteLogin, type RemoteSession } from '../src/remote-login.ts'

const skip = skipHeaded
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
  return { ...webDefaults(join(root, `profile-${count++}`)), url: `${base}?${query}`, executablePath: CHROME, timeouts: { load: 10, answer: 20, stable: 0.5 }, ...extra }
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

const vnc = findVnc()
const skipVnc = skip || (vnc ? false : 'neither x11vnc nor x0vncserver is on PATH (see docs/operations/runbooks.md)')
const gone = (session: RemoteSession, chrome: number) => {
  assert.equal(alive(session.xvfbPid), false, 'Xvfb is still running')
  assert.deepEqual(session.vncPids(), [], 'a VNC server is still running')
  assert.equal(alive(chrome), false, 'the browser is still running')
  assert.equal(existsSync(session.socketDir), false, 'the VNC socket directory is still there')
}

/** The TCP ports the processes listen on, read from their sockets and the kernel's tables. */
function listening(pids: number[]): string[] {
  const inodes = new Set(pids.flatMap((pid) => readdirSync(`/proc/${pid}/fd`).map((fd) => readlinkSync(`/proc/${pid}/fd/${fd}`)).map((l) => /^socket:\[(\d+)\]$/.exec(l)?.[1]).filter(Boolean)))
  return ['tcp', 'tcp6'].flatMap((table) => readFileSync(`/proc/net/${table}`, 'utf8').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f[3] === '0A' && inodes.has(f[9])).map((f) => `${table} ${f[1]}`))
}

/** The status of a GET with a given Host header (fetch will not send one). */
const statusWithHost = (url: string, host: string) => new Promise<number | undefined>((done, fail) => httpRequest(url, { headers: { host } }, (res) => { res.resume(); done(res.statusCode) }).on('error', fail).end())

/** A minimal RFB 3.8 client over the WebSocket the page gets: the handshake with no security, then pointer events, which the X server sees as real input. */
async function rfb(url: string) {
  const ws = new WebSocket(`${url.replace(/^http/, 'ws')}websockify`)
  ws.binaryType = 'arraybuffer'
  let buffer = Buffer.alloc(0)
  const waiting: (() => void)[] = []
  ws.onmessage = (m) => { buffer = Buffer.concat([buffer, Buffer.from(m.data as ArrayBuffer)]); waiting.splice(0).forEach((w) => w()) }
  await new Promise<void>((ok, fail) => { ws.onopen = () => ok(); ws.onerror = () => fail(new Error('the WebSocket was refused')) })
  const take = async (n: number) => {
    while (buffer.length < n) await new Promise<void>((w) => waiting.push(w))
    const out = buffer.subarray(0, n)
    buffer = buffer.subarray(n)
    return out
  }
  const banner = (await take(12)).toString()
  ws.send(Buffer.from('RFB 003.008\n'))
  await take((await take(1))[0]!)
  ws.send(Buffer.from([1]))
  assert.equal((await take(4)).readUInt32BE(0), 0, 'security result')
  ws.send(Buffer.from([1]))
  const init = await take(24)
  await take(init.readUInt32BE(20))
  // Like noVNC, ask for raw updates of the whole screen before any input.
  ws.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]))
  ws.send(Buffer.from([3, 0, 0, 0, 0, 0, init.readUInt16BE(0) >> 8, init.readUInt16BE(0) & 255, init.readUInt16BE(2) >> 8, init.readUInt16BE(2) & 255]))
  return {
    banner, width: init.readUInt16BE(0), height: init.readUInt16BE(2),
    pointer: (x: number, y: number, buttons: number) => ws.send(Buffer.from([5, buttons, x >> 8, x & 255, y >> 8, y & 255])),
    close: () => ws.close(),
  }
}

/** Click the page's Log in button with real pointer input: the page sits below the browser's own toolbar, so rows are tried until its click arrives. */
async function clickLogin(session: RemoteSession) {
  const screen = await rfb(session.url)
  try {
    for (let y = 94; y < 200 && !events.some((e) => e.type === 'click' && e.id === 'login'); y += 4) {
      screen.pointer(30, y, 1)
      // Press and release apart, as a hand does: x11vnc folds two events that arrive together into the last.
      await new Promise((r) => setTimeout(r, 80))
      screen.pointer(30, y, 0)
      await new Promise((r) => setTimeout(r, 150))
    }
  } finally {
    screen.close()
  }
  await until('the click to arrive', () => events.some((e) => e.type === 'click' && e.id === 'login'))
}

test('without a VNC server on PATH --remote fails at once, naming x11vnc and x0vncserver, and starts nothing', { timeout: 30_000 }, async () => {
  const was = process.env.PATH
  process.env.PATH = mkdtempSync(join(root, 'empty-path-'))
  try {
    await assert.rejects(startRemoteLogin(web('scenario=remote')), /x11vnc.*x0vncserver|x0vncserver.*x11vnc/)
  } finally {
    process.env.PATH = was
  }
})

test('the session serves noVNC behind a random token, and says how to reach it', { skip: skipVnc, timeout: 60_000 }, async () => {
  await withSession(web('scenario=remote'), async (session) => {
    const url = new URL(session.url)
    assert.equal(url.hostname, '127.0.0.1')
    assert.match(url.pathname, /^\/[A-Za-z0-9_-]{43}\/$/)
    assert.equal(session.ssh, `ssh -L ${url.port}:127.0.0.1:${url.port} ${session.sshTarget}`)
    const page = await get(session.url)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /Save/)
    assert.match(html, /Cancel/)
    assert.match(html, /scaleViewport = true/, 'the screen is scaled to the window')
    assert.equal((await get(`${session.url}novnc/core/rfb.js`)).status, 200)
    assert.equal((await get(`${session.url}novnc/core/../package.json`)).status, 404)
    assert.equal((await get(`${session.url}novnc/%2e%2e/package.json`)).status, 404)
    for (const path of ['/', '/status', '/save', `/${'0'.repeat(43)}/`, `/${'0'.repeat(43)}/novnc/core/rfb.js`]) {
      assert.equal((await get(`${url.origin}${path}`)).status, 404, path)
    }
    assert.equal((await post(`${url.origin}/${'0'.repeat(43)}/save`, {})).status, 404)
    assert.equal(await statusWithHost(session.url, 'evil.example'), 404, 'only a loopback Host header')
  })
})

test('the WebSocket reaches the VNC socket of the whole screen, and only behind the token', { skip: skipVnc, timeout: 60_000 }, async () => {
  await withSession(web('scenario=remote'), async (session) => {
    const screen = await rfb(session.url)
    assert.match(screen.banner, /^RFB 003\.00\d\n$/)
    assert.equal(screen.width, 1440, 'the whole Xvfb screen, not one tab')
    assert.equal(screen.height, 1000)
    assert.ok(session.vncPids().length > 0, 'a VNC server serves the connection')
    assert.deepEqual(listening(session.vncPids()), [], 'no TCP port is open for it')
    screen.close()
    await assert.rejects(rfb(`${new URL(session.url).origin}/${'0'.repeat(43)}/`), /refused/)
    assert.equal(statSync(session.socketDir).mode & 0o777, 0o700, 'the socket directory is owner-only')
  })
})

test('Save refuses a POST from another origin, then closes the browser, keeps the session and reports the signed-in state', { skip: skipVnc, timeout: 90_000 }, async () => {
  events.length = 0
  const config = web('scenario=remote')
  const session = await startRemoteLogin(config)
  let chrome = 0
  try {
    await until('the page to load', () => events.some((e) => e.type === 'load'))
    chrome = profileLockPid(config.profileDir)!
    assert.ok(chrome)
    // Real pointer input through VNC, as the operator's: the Log in button sets the session cookie.
    await clickLogin(session)
    assert.equal((await fetch(`${session.url}save`, { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403)
    const saved = await fetch(`${session.url}save`, { method: 'POST', headers: { origin: new URL(session.url).origin } })
    assert.equal(saved.status, 200)
    assert.deepEqual(await saved.json(), { state: 'complete', message: 'signed in' })
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

test('Cancel ends the session without a sign-in, and cleans up', { skip: skipVnc, timeout: 90_000 }, async () => {
  events.length = 0
  const config = web('scenario=remote')
  const session = await startRemoteLogin(config)
  await until('the page to load', () => events.some((e) => e.type === 'load'))
  const chrome = profileLockPid(config.profileDir)!
  try {
    const origin = new URL(session.url).origin
    assert.equal((await fetch(`${session.url}cancel`, { method: 'POST', headers: { origin } })).status, 200)
    const report = await session.done
    assert.equal(report.signedIn, false)
    assert.match(report.detail, /cancelled/)
    gone(session, chrome)
  } finally {
    await session.cancel()
    await session.done
  }
})

test('the session expires after its time, and Xvfb, the VNC server, the browser and the server are gone', { skip: skipVnc, timeout: 60_000 }, async () => {
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
  // The answer never starts, so the attempt is still running while the browser is looked at.
  const fake = new FakeChatGpt({ thinkMs: 60_000 })
  await fake.start()
  try {
    const config = { ...web(''), url: `${fake.origin}/` }
    const account: WebAccount = { ref: 'chatgpt-web/default', capabilities: ['research'], command: CHROME, version: async () => 'fake', web: config }
    const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...CONVERSATION_KIND, content: conversationSchema })
    const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'x' }, classification: 'local-private', producer: { type: 'operator', ref: 'tester' } })).id
    const stop = new AbortController()
    const request: WorkerRequest = { workId: 'work:test', attemptId: 'attempt:display', stepId: 'research', capabilities: ['research'], inputs: { task }, outputs: ['report'], signal: stop.signal }
    const running = webWorker(account, artifacts, join(root, 'attempts')).run(request)
    await until('the prompt to be sent', () => fake.sent.length === 1)
    const chrome = profileLockPid(config.profileDir)!
    const env = readFileSync(`/proc/${chrome}/environ`, 'utf8').split('\0')
    const display = env.find((e) => e.startsWith('DISPLAY='))!.slice('DISPLAY='.length)
    assert.match(display, /^:\d+$/, 'the browser runs on a private display')
    assert.ok(existsSync(`/tmp/.X11-unix/X${display.slice(1)}`), 'the display is up')
    assert.doesNotMatch(readFileSync(`/proc/${chrome}/cmdline`, 'utf8'), /--headless/)
    const xvfb = execFileSync('pgrep', ['-f', `Xvfb ${display} `], { encoding: 'utf8' }).trim().split('\n').map(Number)
    assert.equal(xvfb.length, 1)
    stop.abort()
    assert.equal((await running).status, 'cancelled')
    await until('Xvfb to stop', () => !alive(xvfb[0]!), 5000)
    assert.equal(existsSync(`/tmp/.X11-unix/X${display.slice(1)}`), false)
    assert.equal(alive(chrome), false)
  } finally {
    await fake.stop()
    if (was !== undefined) process.env.DISPLAY = was
  }
})

test('Xvfbs that start together from the same display number each get their own display', { skip: findXvfb() ? false : 'Xvfb is not installed', timeout: 60_000 }, async () => {
  const random = Math.random
  Math.random = () => 0.5
  const displays = await Promise.allSettled(Array.from({ length: 4 }, () => startXvfb()))
  Math.random = random
  try {
    const up = displays.map((d) => { assert.equal(d.status, 'fulfilled'); return (d as PromiseFulfilledResult<Awaited<ReturnType<typeof startXvfb>>>).value })
    assert.equal(new Set(up.map((d) => d.display)).size, up.length, 'one display each')
    for (const d of up) {
      assert.equal(Number(readFileSync(`/tmp/.X${d.display.slice(1)}-lock`, 'utf8')), d.pid, `${d.display} belongs to the Xvfb that was started for it`)
    }
  } finally {
    for (const d of displays) if (d.status === 'fulfilled') await d.value.stop()
  }
})

/** Mount the `web-worker` row on a bare context and register an account with it: whether it is available, and the reason if not. */
async function accountsOf(account: Record<string, unknown>, path?: string) {
  let registered = 0
  const provided: Record<string, any> = {}
  const services: Record<string, unknown> = { capabilities: { registerWorker: () => { registered += 1; return () => {} } }, artifacts: {}, subprocess: { resolveExecutable: async (command: string) => command } }
  const ctx = { get: (key: string) => services[key], effect() {}, provide: (key: string, value: unknown) => { provided[key] = value } }
  const was = process.env.PATH
  if (path !== undefined) process.env.PATH = path
  let reason = 'registered'
  try {
    apply(ctx as never)
    await provided.webWorker.register({ ref: 'chatgpt-web/default', capabilities: ['research'], executablePath: CHROME, ...account })
  } catch (error) {
    reason = (error as Error).message
  } finally {
    process.env.PATH = was
  }
  return { accounts: [{ available: reason === 'registered', reason }], registered }
}

test('without Xvfb the account is unavailable and the reason names it', { timeout: 30_000 }, async () => {
  const { accounts, registered } = await accountsOf({}, mkdtempSync(join(root, 'empty-path-')))
  assert.equal(accounts[0]!.available, false)
  assert.match(accounts[0]!.reason, /Xvfb is not installed/)
  assert.equal(registered, 0)
})

test('headless is not an option: an account that asks for it is unavailable', { timeout: 30_000 }, async () => {
  const { accounts } = await accountsOf({ headless: true })
  assert.equal(accounts[0]!.available, false)
  assert.match(accounts[0]!.reason, /headless is not an option/)
})
