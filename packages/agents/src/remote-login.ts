/**
 * The remote sign-in of the `chatgpt-web` Runtime (PROP-0005): the account's
 * profile is opened headed on a private Xvfb, and a viewer for the operator is
 * served on 127.0.0.1 behind a random token. The operator reaches it with an
 * SSH tunnel, sees the tab as a CDP screencast over Server-Sent Events, and
 * their clicks, scrolls and keys go back as POSTs. Nothing here solves or
 * clicks a challenge: the human does, in the viewer. Pure Node: no VNC, no
 * CDP port (the engine talks to Chrome over a pipe).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname, userInfo } from 'node:os'
import type { BrowserContext, CDPSession, Page } from 'patchright-core'
import { checkSignedIn, keepSessionCookies, type LoginReport } from './chatgpt-login.ts'
import { launch, type WebConfig } from './chatgpt.ts'
import { startXvfb } from './display.ts'

/** How long a session lives, unless it is saved or cancelled first. */
export const REMOTE_TTL_MS = 15 * 60_000
const MAX_BODY = 64 * 1024

export interface RemoteOptions {
  ttlMs?: number
  /** For the printed `ssh` line; default the Host's user and host name. */
  user?: string
  host?: string
}

export interface RemoteSession {
  /** `http://127.0.0.1:<port>/<token>/` */
  url: string
  port: number
  /** `ssh -L <port>:127.0.0.1:<port> <user>@<host>` */
  ssh: string
  sshTarget: string
  /** Epoch milliseconds. */
  expiresAt: number
  display: string
  xvfbPid: number
  /** The outcome, once the browser, Xvfb and the server are gone. */
  done: Promise<LoginReport>
  /** End the session without saving; a no-op once it has ended. */
  cancel(): Promise<void>
}

const NUMBER = (v: unknown, min = -1e6, max = 1e6): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const TEXT = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length <= max
const MODIFIERS = (v: unknown) => v === undefined || NUMBER(v, 0, 15)

/** A viewer input as the CDP call it becomes, or undefined when it is malformed. */
export function toCdp(input: any): [string, Record<string, unknown>] | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  if (input.type === 'mouse') {
    if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(input.kind) || !NUMBER(input.x) || !NUMBER(input.y) || !MODIFIERS(input.modifiers)) return undefined
    if (input.button !== undefined && !['none', 'left', 'middle', 'right'].includes(input.button)) return undefined
    if (input.clickCount !== undefined && !NUMBER(input.clickCount, 0, 5)) return undefined
    if ((input.deltaX !== undefined && !NUMBER(input.deltaX)) || (input.deltaY !== undefined && !NUMBER(input.deltaY))) return undefined
    return ['Input.dispatchMouseEvent', { type: input.kind, x: input.x, y: input.y, button: input.button ?? 'none', clickCount: input.clickCount ?? 0, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0, modifiers: input.modifiers ?? 0 }]
  }
  if (input.type === 'key') {
    if (!['keyDown', 'rawKeyDown', 'keyUp'].includes(input.kind) || !TEXT(input.key) || !TEXT(input.code) || !NUMBER(input.keyCode ?? 0, 0, 255) || !MODIFIERS(input.modifiers)) return undefined
    if (input.text !== undefined && !TEXT(input.text, 8)) return undefined
    return ['Input.dispatchKeyEvent', { type: input.kind, key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode ?? 0, nativeVirtualKeyCode: input.keyCode ?? 0, modifiers: input.modifiers ?? 0, ...(input.text ? { text: input.text, unmodifiedText: input.text } : {}) }]
  }
  if (input.type === 'text' && TEXT(input.text, 10_000)) return ['Input.insertText', { text: input.text }]
  return undefined
}

/** The page the operator sees: the frame on a canvas, and the input sent back in the frame's own pixels. */
const VIEWER = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>System sign-in</title>
<style>
body { margin: 0; font: 14px sans-serif; background: #222; color: #eee }
header { display: flex; gap: 8px; align-items: center; padding: 8px }
button { font: inherit; padding: 4px 14px }
canvas { display: block; max-width: 100%; height: auto; outline: none; background: #fff }
</style></head>
<body>
<header><button id="save">Save</button><button id="cancel">Cancel</button><span id="status">Connecting...</span></header>
<canvas id="screen" tabindex="0" width="1280" height="900"></canvas>
<script>
const canvas = document.getElementById('screen')
const status = document.getElementById('status')
const context = canvas.getContext('2d')
const send = (input) => fetch('input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).catch(() => {})
const events = new EventSource('events')
events.onmessage = (message) => {
  const frame = JSON.parse(message.data)
  const image = new Image()
  image.onload = () => {
    if (canvas.width !== frame.width || canvas.height !== frame.height) { canvas.width = frame.width; canvas.height = frame.height }
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
  }
  image.src = 'data:image/jpeg;base64,' + frame.data
  status.textContent = 'Sign in, clear any check by hand, then press Save.'
}
events.onerror = () => { status.textContent = 'Disconnected.' }
const finish = async (action) => {
  status.textContent = action === 'save' ? 'Saving and checking the sign-in...' : 'Cancelling...'
  try {
    const report = await (await fetch(action, { method: 'POST' })).json()
    status.textContent = report.signedIn ? 'Signed in. You can close this tab.' : 'Not signed in: ' + report.detail
  } catch { status.textContent = 'The session has ended.' }
  events.close()
}
document.getElementById('save').onclick = () => finish('save')
document.getElementById('cancel').onclick = () => finish('cancel')
// Frame pixels are the page's CSS pixels, so a point on the scaled canvas is scaled back.
const point = (e) => {
  const r = canvas.getBoundingClientRect()
  return { x: Math.round((e.clientX - r.left) * canvas.width / r.width), y: Math.round((e.clientY - r.top) * canvas.height / r.height) }
}
const modifiers = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
const BUTTONS = ['left', 'middle', 'right']
let held = 'none'
let lastMove = 0
canvas.addEventListener('mousedown', (e) => { e.preventDefault(); canvas.focus({ preventScroll: true }); held = BUTTONS[e.button] || 'left'; send({ type: 'mouse', kind: 'mousePressed', ...point(e), button: held, clickCount: e.detail || 1, modifiers: modifiers(e) }) })
canvas.addEventListener('mouseup', (e) => { e.preventDefault(); send({ type: 'mouse', kind: 'mouseReleased', ...point(e), button: BUTTONS[e.button] || 'left', clickCount: e.detail || 1, modifiers: modifiers(e) }); held = 'none' })
canvas.addEventListener('mousemove', (e) => {
  if (Date.now() - lastMove < 40) return
  lastMove = Date.now()
  send({ type: 'mouse', kind: 'mouseMoved', ...point(e), button: held, modifiers: modifiers(e) })
})
canvas.addEventListener('wheel', (e) => { e.preventDefault(); send({ type: 'mouse', kind: 'mouseWheel', ...point(e), deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e) }) }, { passive: false })
canvas.addEventListener('contextmenu', (e) => e.preventDefault())
const paste = (e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v'
canvas.addEventListener('keydown', (e) => {
  if (paste(e)) return
  e.preventDefault()
  const text = e.key === 'Enter' ? '\r' : e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey ? e.key : ''
  send({ type: 'key', kind: text ? 'keyDown' : 'rawKeyDown', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e), ...(text ? { text } : {}) })
})
canvas.addEventListener('keyup', (e) => { if (paste(e)) return; e.preventDefault(); send({ type: 'key', kind: 'keyUp', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiers(e) }) })
canvas.addEventListener('paste', (e) => { e.preventDefault(); const text = e.clipboardData.getData('text'); if (text) send({ type: 'text', text }) })
</script></body></html>`

const SECURITY = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'" }

const digest = (text: string) => createHash('sha256').update(text).digest()

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) { reject(new Error('too large')); req.destroy() }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/** Start Xvfb and the profile's headed browser on it, open the page and serve the viewer. Everything it started is stopped on Save, Cancel, expiry or the browser closing. */
export async function startRemoteLogin(web: WebConfig, options: RemoteOptions = {}): Promise<RemoteSession> {
  const display = await startXvfb()
  let context: BrowserContext | undefined
  let server: Server | undefined
  try {
    context = await launch(web, display)
    const first = context.pages()[0] ?? await context.newPage()
    await first.goto(web.url, { waitUntil: 'domcontentloaded', timeout: web.timeouts.load * 1000 }).catch(() => {})
    server = createServer()
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    return await serve(web, context, first, server, display, options)
  } catch (error) {
    server?.close()
    await context?.close().catch(() => {})
    await display.stop()
    throw error
  }
}

async function serve(web: WebConfig, context: BrowserContext, first: Page, server: Server, display: Awaited<ReturnType<typeof startXvfb>>, options: RemoteOptions): Promise<RemoteSession> {
  const port = (server.address() as AddressInfo).port
  const token = randomBytes(32).toString('hex')
  const wanted = digest(token)
  const ttl = options.ttlMs ?? REMOTE_TTL_MS
  const expiresAt = Date.now() + ttl
  const clients = new Set<ServerResponse>()
  let latest: string | undefined
  let current: Page | undefined
  let cdp: CDPSession | undefined

  const broadcast = (frame: string) => {
    for (const client of clients) if (!client.writableNeedDrain) client.write(`data: ${frame}\n\n`)
  }
  /** Show `page`, the newest tab: a sign-in popup is the one the operator needs. */
  async function show(page: Page): Promise<void> {
    if (current === page) return
    await cdp?.send('Page.stopScreencast').catch(() => {})
    current = page
    const session = await context.newCDPSession(page)
    cdp = session
    session.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      latest = JSON.stringify({ data: frame.data, width: Math.round(frame.metadata.deviceWidth), height: Math.round(frame.metadata.deviceHeight) })
      broadcast(latest)
    })
    page.once('close', () => {
      if (current !== page) return
      current = undefined
      const rest = context.pages().at(-1)
      if (rest) void show(rest).catch(() => {})
    })
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 2048, maxHeight: 2048 })
  }
  context.on('page', (page) => { void show(page).catch(() => {}) })
  await show(first)

  let outcome: Promise<LoginReport> | undefined
  let resolveDone!: (report: LoginReport) => void
  const done = new Promise<LoginReport>((resolve) => { resolveDone = resolve })
  const ttlTimer = setTimeout(() => { void finish('expired') }, ttl)
  context.on('close', () => { void finish('closed') })

  function finish(why: 'save' | 'cancel' | 'expired' | 'closed'): Promise<LoginReport> {
    if (outcome) return outcome
    clearTimeout(ttlTimer)
    outcome = (async (): Promise<LoginReport> => {
      try {
        await cdp?.send('Page.stopScreencast').catch(() => {})
        if (why === 'save') await keepSessionCookies(context).catch(() => {})
        // A clean close, so the profile keeps what the sign-in set (cf_clearance, the session).
        await context.close().catch(() => {})
        if (why === 'save') return await checkSignedIn(web, display).catch((error: Error) => ({ signedIn: false, detail: `the check failed: ${error.message.split('\n')[0]}` }))
        return { signedIn: false, detail: { cancel: 'cancelled', expired: `expired after ${Math.round(ttl / 60_000)} minute(s) without Save`, closed: 'the browser was closed before Save' }[why] }
      } finally {
        await display.stop()
      }
    })()
    void outcome.then(async (report) => {
      for (const client of clients) client.end()
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      // Idle connections go now; one still answering is given a second.
      server.closeIdleConnections()
      const force = setTimeout(() => server.closeAllConnections(), 1000)
      await closed
      clearTimeout(force)
      resolveDone(report)
    })
    return outcome
  }

  server.on('request', async (req, res) => {
    const reply = (status: number, body = '', type = 'text/plain') => { res.writeHead(status, { 'content-type': type, ...SECURITY }); res.end(body) }
    try {
      const [, given = '', action = ''] = /^\/([^/?]*)\/?([^/?]*)/.exec(req.url ?? '') ?? []
      // Anything without the token, whatever it asks for, is forbidden.
      if (!timingSafeEqual(digest(given), wanted)) return reply(403, 'forbidden')
      const post = req.method === 'POST'
      if (action === '' && req.method === 'GET') return reply(200, VIEWER, 'text/html; charset=utf-8')
      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', ...SECURITY })
        clients.add(res)
        res.on('close', () => clients.delete(res))
        if (latest) res.write(`data: ${latest}\n\n`)
        return
      }
      if (action === 'input' && post) {
        const call = toCdp(JSON.parse(await readBody(req) || 'null'))
        if (!call) return reply(400, 'bad input')
        await cdp?.send(call[0] as never, call[1] as never).catch(() => {})
        res.writeHead(204, SECURITY)
        return void res.end()
      }
      if ((action === 'save' || action === 'cancel') && post) {
        await readBody(req)
        const report = await finish(action)
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close', ...SECURITY })
        return void res.end(JSON.stringify(report))
      }
      return reply(404, 'not found')
    } catch {
      if (!res.headersSent) reply(400, 'bad request')
      else res.end()
    }
  })

  const sshTarget = `${options.user ?? userInfo().username}@${options.host ?? hostname()}`
  return { url: `http://127.0.0.1:${port}/${token}/`, port, ssh: `ssh -L ${port}:127.0.0.1:${port} ${sshTarget}`, sshTarget, expiresAt, display: display.display, xvfbPid: display.pid, done, cancel: async () => { await finish('cancel') } }
}
