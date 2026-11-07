/**
 * Which Chrome the `chatgpt-web` Runtime launches (PROP-0005): the configured
 * path, then `CHROME_PATH`, then a system Chrome no older than the engine's
 * Chromium, then the **managed** Chrome for Testing build pinned in
 * `chrome.lock.json`, installed with `@puppeteer/browsers` under
 * `<DSH_HOME>/system/browsers` the first time it is needed. Ported from System
 * 1's packages/plugins/browser-patchright/src/chrome.ts. A Chrome much older
 * than the engine's Chromium is a browser chatgpt.com's challenge treats as
 * suspect, and Playwright's calls expect the newer protocol.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser, computeExecutablePath, install as puppeteerInstall } from '@puppeteer/browsers'

export interface ChromeLock {
  browser: 'chrome'
  buildId: string
}

export const CHROME_LOCK: ChromeLock = JSON.parse(readFileSync(new URL('../chrome.lock.json', import.meta.url), 'utf8')) as ChromeLock

const STANDARD_CHROME_PATHS = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']

/** The Chromium major that patchright-core is built against. */
export function engineChromiumMajor(): number {
  const pkg = createRequire(import.meta.url).resolve('patchright-core/package.json')
  const { browsers } = JSON.parse(readFileSync(join(dirname(pkg), 'browsers.json'), 'utf8')) as { browsers: Array<{ name: string; browserVersion: string }> }
  return Number(browsers.find((b) => b.name === 'chromium')?.browserVersion.split('.')[0])
}

/** The major version `path --version` reports, or undefined when it does not run. */
export function chromeMajor(path: string): number | undefined {
  try {
    const major = /(\d+)\.\d+\.\d+/.exec(execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000 }))?.[1]
    return major === undefined ? undefined : Number(major)
  } catch {
    return undefined
  }
}

/** `<DSH_HOME>/system/browsers`, for a caller that has no Cordis context. */
export const defaultBrowsersDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'system', 'browsers')

/** The pinned managed Chrome's path, whether or not it is installed yet. */
export function managedChromePath(dir: string = defaultBrowsersDir(), lock: ChromeLock = CHROME_LOCK): string {
  return computeExecutablePath({ browser: Browser.CHROME, buildId: lock.buildId, cacheDir: dir })
}

export interface ChromeChoice {
  path: string
  source: 'configured' | 'env' | 'system' | 'managed'
}

export interface DiscoverOptions {
  standard?: readonly string[]
  managedDir?: string
  /** Only for tests: how old a Chrome may be. */
  minimum?: number
}

/** The Chrome to run: never undefined, because the managed build is installed by `ensureChrome` when it is the choice and is missing. */
export function discoverChrome(configured: string | undefined, options: DiscoverOptions = {}): ChromeChoice {
  if (configured !== undefined) {
    if (!existsSync(configured)) throw new Error(`the configured Chrome path does not exist: ${configured}`)
    return { path: configured, source: 'configured' }
  }
  const env = process.env.CHROME_PATH
  if (env && existsSync(env)) return { path: env, source: 'env' }
  const minimum = options.minimum ?? engineChromiumMajor()
  for (const path of options.standard ?? STANDARD_CHROME_PATHS) {
    if (existsSync(path) && (chromeMajor(path) ?? 0) >= minimum) return { path, source: 'system' }
  }
  return { path: managedChromePath(options.managedDir), source: 'managed' }
}

type Installer = (options: { browser: Browser; buildId: string; cacheDir: string }) => Promise<{ executablePath: string }>

const installing = new Map<string, Promise<string>>()

/** Install the pinned managed Chrome unless it is present; concurrent calls for one directory share one install. */
export function installManagedChrome(options: { dir?: string; lock?: ChromeLock; install?: Installer } = {}): Promise<string> {
  const dir = options.dir ?? defaultBrowsersDir()
  const lock = options.lock ?? CHROME_LOCK
  const path = managedChromePath(dir, lock)
  if (existsSync(path)) return Promise.resolve(path)
  const key = `${dir}\0${lock.buildId}`
  let run = installing.get(key)
  if (!run) {
    // The installer creates directories with the process umask; create ours owner-only first.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const install = options.install ?? ((o) => puppeteerInstall({ ...o, unpack: true }))
    run = install({ browser: Browser.CHROME, buildId: lock.buildId, cacheDir: dir })
      .then((installed) => installed.executablePath, (error: Error) => { throw new Error(`could not install Chrome for Testing ${lock.buildId} under ${dir}: ${error.message.split('\n')[0]}`, { cause: error }) })
      .finally(() => installing.delete(key))
    installing.set(key, run)
  }
  return run
}

/** The executable to launch: the choice, after installing the managed build if that is the choice and it is missing. */
export async function ensureChrome(configured: string | undefined, managedDir?: string): Promise<ChromeChoice> {
  const choice = discoverChrome(configured, { ...(managedDir ? { managedDir } : {}) })
  if (choice.source === 'managed' && !existsSync(choice.path)) await installManagedChrome({ ...(managedDir ? { dir: managedDir } : {}) })
  return choice
}
