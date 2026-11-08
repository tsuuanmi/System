/**
 * The remote sign-in of the `chatgpt-web` Runtime (PROP-0005): the account's
 * profile is opened headed on a private Xvfb, and the operator sees and drives
 * the whole screen of that Xvfb as a VNC desktop through noVNC, scaled to
 * their browser window, with real X input (a Cloudflare challenge is cleared
 * by hand). Nothing here solves or clicks a challenge: the human does.
 *
 * Ported from System 1 (~/workspaces/system, commit f199a277b2634f8995a499601cbf03616aa639f7),
 * `packages/plugins/login/src/remote.ts` (last changed in 750257ae) and the
 * VNC lookup of `src/index.ts` (`findOnPath`, now `findVnc` in display.ts),
 * with its fixes kept:
 * - a VNC server listens only on an owner-only unix socket, so no TCP port
 *   exists for other local users (TigerVNC's `x0vncserver`, as System 1; see
 *   below for `x11vnc`);
 * - a loopback HTTP server behind a random URL token serves noVNC and bridges
 *   its WebSocket to that socket; only a loopback Host header is answered, and a
 *   POST of Save or Cancel only from the page's own origin;
 * - a taken port is a typed failure; every process, the socket and the
 *   server are stopped on Save, Cancel, expiry or the browser closing.
 * One change of System 1's: `x11vnc` is started per connection with `-inetd`
 * (RFB over its stdin and stdout) behind a unix socket this process listens on.
 * System 1's `-unixsockonly` does not exist in x11vnc 0.9.16 (Ubuntu 20.04),
 * and its `-unixsock` there still listens on TCP port 5900 with no password.
 * The browser is System's own (`launch`, as an attempt's) and the Save check
 * is the web-driver's `checkAuth` (`checkSignedIn`). noVNC (`@novnc/novnc`
 * 1.7.0, MPL-2.0) is served unmodified from its package; `ws` 8.22.0 is MIT.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net'
import { hostname, userInfo } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { BrowserContext } from 'patchright-core'
import { WebSocketServer, type WebSocket } from 'ws'
import type { LoginReport } from '@system/agents'
import { checkSignedIn, keepSessionCookies } from './chatgpt-login.ts'
import { refuseBrowser } from './no-browser.ts'
import { chromeTmpdir, launch, type WebConfig } from './chatgpt.ts'
import { findVnc, startXvfb, VNC_MISSING, type Display } from './display.ts'

/** How long a session lives, unless it is saved or cancelled first. */
export const REMOTE_TTL_MS = 15 * 60_000

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
  /** The VNC processes running now. */
  vncPids(): number[]
  /** Private directory of the VNC socket (removed when the session ends). */
  socketDir: string
  /** The outcome, once the browser, the VNC server, Xvfb and the server are gone. */
  done: Promise<LoginReport>
  /** End the session without saving; a no-op once it has ended. */
  cancel(): Promise<void>
}

const LOOPBACK = '127.0.0.1'
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost'])
// The package exports only `./core/rfb.js`; its directory is the package root's `core/`.
const NOVNC_ROOT = dirname(dirname(createRequire(import.meta.url).resolve('@novnc/novnc')))
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }

const running = (child: ChildProcess | undefined): child is ChildProcess => child?.pid !== undefined && child.exitCode === null && child.signalCode === null

function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!running(child)) return Promise.resolve(true)
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
  })
}

async function stop(child: ChildProcess | undefined, graceMs: number): Promise<void> {
  if (!running(child)) return
  child.kill('SIGTERM')
  if (!(await exited(child, graceMs))) {
    child.kill('SIGKILL')
    await exited(child, 2000)
  }
}

/** The VNC server of one session: it takes only the X authority of the private Xvfb. */
interface Vnc {
  /** Resolves when it can be connected to. */
  ready(): Promise<void>
  /** Carry the RFB stream of `ws`. */
  attach(ws: WebSocket): void
  /** The VNC processes running now. */
  pids(): number[]
  stop(): Promise<void>
}

/** The WebSocket of the page, carried to and from the unix socket of the VNC server. */
function bridge(socket: string, ws: WebSocket): void {
  const vnc = connect(socket)
  vnc.on('data', (chunk) => ws.send(chunk))
  ws.on('message', (data) => vnc.write(data as Buffer))
  vnc.on('close', () => ws.close())
  vnc.on('error', () => ws.close())
  ws.on('close', () => vnc.destroy())
}

/** `x0vncserver` listens on an owner-only unix socket and is up for the whole session. */
function socketVnc(vncPath: string, display: Display, socketDir: string): Vnc {
  const socket = join(socketDir, 'vnc.sock')
  const child = spawn(vncPath, ['-display', display.display, '-rfbport', '-1', '-rfbunixpath', socket, '-rfbunixmode', '0600', '-SecurityTypes', 'None'], { env: { ...process.env, ...display.env }, stdio: 'ignore' })
  return {
    async ready() {
      for (const deadline = Date.now() + 5000; !existsSync(socket); await new Promise((done) => setTimeout(done, 100))) {
        if (!running(child)) throw new Error(`the VNC server (${vncPath}) exited before listening; ${VNC_MISSING}`)
        if (Date.now() > deadline) throw new Error('the VNC server did not create its socket in time')
      }
    },
    attach: (ws) => bridge(socket, ws),
    pids: () => (running(child) ? [child.pid!] : []),
    stop: () => stop(child, 2000),
  }
}

/**
 * `x11vnc` runs once per connection with `-inetd` (the connection is its stdin and stdout), behind an
 * owner-only unix socket this process listens on: no TCP port exists at all.
 */
function inetdVnc(vncPath: string, display: Display, socketDir: string): Vnc {
  const socket = join(socketDir, 'vnc.sock')
  const children = new Set<ChildProcess>()
  // Paused, so only the child reads the connection.
  const listener = createNetServer({ pauseOnConnect: true }, (connection) => {
    const child = spawn(vncPath, ['-inetd', '-display', display.display, '-auth', display.env.XAUTHORITY!, '-shared', '-nopw', '-quiet'], { env: { ...process.env, ...display.env }, stdio: [connection, connection, 'ignore'] })
    children.add(child)
    child.once('exit', () => children.delete(child))
    child.once('spawn', () => connection.destroy())
    child.once('error', () => connection.destroy())
  })
  return {
    ready: () => new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(socket, () => { chmodSync(socket, 0o600); resolve() })
    }),
    attach: (ws) => bridge(socket, ws),
    pids: () => [...children].filter(running).map((child) => child.pid!),
    stop: async () => {
      listener.close()
      await Promise.all([...children].map((child) => stop(child, 2000)))
    },
  }
}

/** The page the operator sees: the whole remote screen through noVNC, scaled to the window, with Save and Cancel. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>System sign-in</title>
<style>html,body{height:100%;margin:0;background:#111;color:#eee;font:14px system-ui}body{display:grid;grid-template-rows:auto 1fr}
header{display:flex;gap:8px;align-items:center;padding:10px;background:#202124}#status{flex:1}button{padding:8px 14px}#screen{overflow:hidden}</style></head>
<body><header><span id="status">Connecting…</span><button id="save">Save</button><button id="cancel">Cancel</button></header><main id="screen"></main>
<script type="module">
import RFB from './novnc/core/rfb.js'
const status = document.getElementById('status')
const rfb = new RFB(document.getElementById('screen'), location.href.replace(/^http/, 'ws') + 'websockify')
rfb.scaleViewport = true
rfb.addEventListener('connect', () => { status.textContent = 'Sign in, clear any check by hand, then press Save.' })
rfb.addEventListener('disconnect', () => { status.textContent = 'Disconnected.' })
async function post(path) {
  const res = await fetch(path, { method: 'POST' }).catch(() => undefined)
  const body = await res?.json().catch(() => undefined)
  status.textContent = body?.message ?? 'The session has ended.'
}
document.getElementById('save').onclick = () => { status.textContent = 'Saving and checking the sign-in…'; post('save') }
document.getElementById('cancel').onclick = () => post('cancel')
</script></body></html>`

/** Start Xvfb, the VNC server and the profile's headed browser on it, and serve noVNC. Everything it started is stopped on Save, Cancel, expiry or the browser closing. */
export async function startRemoteLogin(web: WebConfig, options: RemoteOptions = {}): Promise<RemoteSession> {
  refuseBrowser()
  // Before anything starts: without a VNC server there is nothing to show.
  const vncPath = findVnc()
  if (!vncPath) throw new Error(VNC_MISSING)
  const display = await startXvfb()
  // The VNC socket shows and drives the login browser: it lives in a directory of mode 0700, under a TMPDIR short enough for a socket path.
  const socketDir = mkdtempSync(join(chromeTmpdir(), 'system-remote-login-'))
  const vnc = basename(vncPath) === 'x11vnc' ? inetdVnc(vncPath, display, socketDir) : socketVnc(vncPath, display, socketDir)
  let context: BrowserContext | undefined
  let server: Server | undefined
  let wss: WebSocketServer | undefined
  try {
    await vnc.ready()
    context = await launch(web, display)
    const first = context.pages()[0] ?? await context.newPage()
    await first.goto(web.url, { waitUntil: 'domcontentloaded', timeout: web.timeouts.load * 1000 }).catch(() => {})
    // The profile restores its last session's tabs: the sign-in page is the one in front.
    await first.bringToFront().catch(() => {})
    server = createServer()
    wss = new WebSocketServer({ noServer: true })
    // A taken port is a typed failure, never an uncaught 'error' event.
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, LOOPBACK, resolve) })
    return serve(web, { display, context, vnc, socketDir, server, wss }, options)
  } catch (error) {
    server?.close()
    wss?.close()
    await context?.close().catch(() => {})
    await vnc.stop()
    await display.stop()
    rmSync(socketDir, { recursive: true, force: true })
    throw error
  }
}

interface Started {
  display: Display
  context: BrowserContext
  vnc: Vnc
  socketDir: string
  server: Server
  wss: WebSocketServer
}

function serve(web: WebConfig, started: Started, options: RemoteOptions): RemoteSession {
  const { display, context, vnc, socketDir, server, wss } = started
  const port = (server.address() as AddressInfo).port
  const origin = `http://${LOOPBACK}:${port}`
  const token = randomBytes(32).toString('base64url')
  const base = `/${token}/`
  const ttl = options.ttlMs ?? REMOTE_TTL_MS
  const expiresAt = Date.now() + ttl

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
        if (why === 'save') await keepSessionCookies(context).catch(() => {})
        // A clean close, so the profile keeps what the sign-in set (cf_clearance, the session).
        await context.close().catch(() => {})
        if (why === 'save') return await checkSignedIn(web, display).catch((error: Error) => ({ signedIn: false, detail: `the check failed: ${error.message.split('\n')[0]}` }))
        return { signedIn: false, detail: { cancel: 'cancelled', expired: `expired after ${Math.round(ttl / 60_000)} minute(s) without Save`, closed: 'the browser was closed before Save' }[why] }
      } finally {
        await vnc.stop()
        await display.stop()
        rmSync(socketDir, { recursive: true, force: true })
      }
    })()
    void outcome.then(async (report) => {
      for (const client of wss.clients) client.terminate()
      wss.close()
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

  const allowedHost = (req: IncomingMessage): boolean => ALLOWED_HOSTS.has((req.headers.host ?? '').split(':')[0] ?? '')

  server.on('upgrade', (req, upgraded, head) => {
    if (!allowedHost(req) || req.url !== `${base}websockify`) {
      upgraded.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, upgraded, head, (ws) => vnc.attach(ws))
  })

  server.on('request', async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-frame-options', 'DENY')
    try {
      const url = req.url ?? '/'
      if (!allowedHost(req) || !url.startsWith(base)) return void res.writeHead(404).end()
      const path = url.slice(base.length)
      if (req.method === 'GET' && path === '') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
      if (req.method === 'GET' && path.startsWith('novnc/')) return serveNoVnc(path.slice('novnc/'.length), res)
      if (req.method === 'POST' && (path === 'save' || path === 'cancel')) {
        // Only this page may press the buttons: a POST from any other origin is refused.
        if (req.headers.origin !== origin) return void res.writeHead(403).end()
        const report = await finish(path)
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        return void res.end(JSON.stringify({ state: path === 'cancel' ? 'ended' : report.signedIn ? 'complete' : 'failed', message: report.detail }))
      }
      res.writeHead(404).end()
    } catch {
      if (!res.headersSent) res.writeHead(400).end()
      else res.end()
    }
  })

  const sshTarget = `${options.user ?? userInfo().username}@${options.host ?? hostname()}`
  return {
    url: `${origin}${base}`, port, ssh: `ssh -L ${port}:${LOOPBACK}:${port} ${sshTarget}`, sshTarget, expiresAt,
    display: display.display, xvfbPid: display.pid, vncPids: () => vnc.pids(), socketDir, done, cancel: async () => { await finish('cancel') },
  }
}

/** A file of noVNC's `core/` or `vendor/`, unmodified; nothing else of the package, and nothing a link leads out of it. */
function serveNoVnc(relative: string, res: ServerResponse): void {
  const decoded = decodeURIComponent(relative.split('?')[0] ?? '')
  const file = resolve(NOVNC_ROOT, decoded)
  const allowed = [join(NOVNC_ROOT, 'core') + sep, join(NOVNC_ROOT, 'vendor') + sep]
  if (!allowed.some((root) => file.startsWith(root)) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end()
  const real = realpathSync(file)
  if (!allowed.some((root) => real.startsWith(realpathSync(root.slice(0, -1)) + sep))) return void res.writeHead(404).end()
  const type = TYPES[real.slice(real.lastIndexOf('.'))] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type }).end(readFileSync(real))
}
