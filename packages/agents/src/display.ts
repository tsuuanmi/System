/**
 * The private display of the `chatgpt-web` Runtime (PROP-0005): System never
 * runs the browser headless. It runs a real, headed Chrome on an invisible
 * display, a private Xvfb that this process owns and stops. Other local users
 * cannot draw on it or read it: it takes only an X authority cookie that sits
 * in a directory of mode 0700, and it listens on no TCP port.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const XVFB_MISSING = 'Xvfb is not installed (apt install xvfb): System runs the browser headed on a private display, never headless'

/** The first of `names` found executable on `PATH` (the names in order, as System 1's login plugin looks for a VNC server), or undefined. */
function findOnPath(names: readonly string[]): string | undefined {
  for (const name of names) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir) continue
      const file = join(dir, name)
      try {
        accessSync(file, constants.X_OK)
        return file
      } catch {
        // Next directory.
      }
    }
  }
  return undefined
}

/** `Xvfb` on `PATH`, or undefined. */
export const findXvfb = (): string | undefined => findOnPath(['Xvfb'])

export const VNC_MISSING = 'remote login needs a VNC server on PATH: x11vnc (apt install x11vnc) or x0vncserver (apt install tigervnc-scraping-server)'

/** The VNC server of the remote login on `PATH`: `x0vncserver` (TigerVNC) or `x11vnc`, or undefined. */
export const findVnc = (): string | undefined => findOnPath(['x0vncserver', 'x11vnc'])

export interface Display {
  /** For example `:101`. */
  display: string
  pid: number
  /** `DISPLAY` and `XAUTHORITY`, to add to a browser's environment. */
  env: Record<string, string>
  /** Stop Xvfb and remove its authority file; returns once it has exited. */
  stop(): Promise<void>
}

const be16 = (n: number) => Buffer.from([n >> 8, n & 0xff])
const field = (data: Buffer) => Buffer.concat([be16(data.length), data])

/** An `.Xauthority` file with one MIT-MAGIC-COOKIE-1 entry for the display, for this host and as a wildcard. */
export function xauthority(number: string, cookie: Buffer): Buffer {
  const entry = (family: number, address: string) => Buffer.concat([be16(family), field(Buffer.from(address)), field(Buffer.from(number)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)])
  return Buffer.concat([entry(256, hostname()), entry(0xffff, '')])
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const socketOf = (number: number) => `/tmp/.X11-unix/X${number}`
/** Whether `pid` is the Xvfb that owns display `number`: the socket can be another Xvfb's while this one is still losing the race, its lock file names the owner. */
const owns = (number: number, pid: number) => {
  try {
    return Number(readFileSync(`/tmp/.X${number}-lock`, 'utf8')) === pid && existsSync(socketOf(number))
  } catch {
    return false
  }
}

/** Start an Xvfb on the first free display number from a random start; one that loses a race for a number exits, and the next number is tried. */
export async function startXvfb(): Promise<Display> {
  const xvfb = findXvfb()
  if (!xvfb) throw new Error(XVFB_MISSING)
  const dir = mkdtempSync(join(tmpdir(), 'system-xvfb-'))
  const auth = join(dir, 'Xauthority')
  const cookie = randomBytes(16)
  const first = 100 + Math.floor(Math.random() * 800)
  try {
    for (let i = 0; i < 40; i++) {
      const number = first + i
      if (existsSync(socketOf(number)) || existsSync(`/tmp/.X${number}-lock`)) continue
      writeFileSync(auth, xauthority(String(number), cookie), { mode: 0o600 })
      const child = spawn(xvfb, [`:${number}`, '-auth', auth, '-nolisten', 'tcp', '-screen', '0', '1440x1000x24'], { stdio: 'ignore' })
      let exited = child.exitCode !== null || child.signalCode !== null
      const exit = new Promise<void>((resolve) => child.once('exit', () => { exited = true; resolve() }))
      child.once('error', () => { exited = true })
      for (let waited = 0; !exited && !owns(number, child.pid!) && waited < 10_000; waited += 25) await sleep(25)
      if (!exited && owns(number, child.pid!)) {
        return {
          display: `:${number}`, pid: child.pid!, env: { DISPLAY: `:${number}`, XAUTHORITY: auth },
          async stop() {
            await stopProcess(child, exit)
            rmSync(dir, { recursive: true, force: true })
          },
        }
      }
      await stopProcess(child, exit)
    }
    throw new Error('no free display number for Xvfb')
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

async function stopProcess(child: ChildProcess, exit: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 3000)
  await exit
  clearTimeout(force)
}

/** What a browser runs on: the operator's own `DISPLAY` when one is set, else a private Xvfb. */
export async function acquireDisplay(): Promise<Display> {
  const own = process.env.DISPLAY
  if (own) return { display: own, pid: 0, env: { DISPLAY: own }, stop: async () => {} }
  return startXvfb()
}
