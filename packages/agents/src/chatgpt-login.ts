/**
 * The sign-in of the `chatgpt-web` Runtime (PROP-0005): the profile is signed
 * in by importing a cookie file the operator exported from their own browser,
 * or by hand in a visible window. A cookie value is never stored outside the
 * profile or reported.
 */
import type { Cookie } from 'playwright-core'
import { WHY, launch, pageState, settle, sleep, type WebConfig } from './chatgpt.ts'

/** How long an imported session cookie lives in the profile. */
const SESSION_COOKIE_DAYS = 30
const DEFAULT_DOMAINS = ['chatgpt.com', 'openai.com']

const domainOf = (domain: string, allowed: readonly string[]) => allowed.some((d) => domain.replace(/^\./, '') === d || domain.replace(/^\./, '').endsWith(`.${d}`))
/** What `context.addCookies` takes; a cookie file never has all of Playwright's fields. */
export type ImportedCookie = Omit<Cookie, 'sameSite'> & { sameSite?: Cookie['sameSite'] }
const SAME_SITE: Record<string, Cookie['sameSite']> = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' }

/** A cookie file the operator exported from their own browser: a JSON list (browser extensions) or Netscape text. Only cookies of `domains` are kept. */
export function parseCookies(text: string, domains: readonly string[] = DEFAULT_DOMAINS): { cookies: ImportedCookie[]; skipped: number } {
  const all: ImportedCookie[] = []
  const trimmed = text.trim()
  if (/^[[{]/.test(trimmed)) {
    let json: unknown
    try {
      json = JSON.parse(trimmed)
    } catch {
      throw new Error('the cookie file is neither a JSON cookie export nor a Netscape cookie file')
    }
    for (const c of (Array.isArray(json) ? json : (json as { cookies?: unknown[] })?.cookies ?? []) as Record<string, unknown>[]) {
      if (typeof c?.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') continue
      const sameSite = SAME_SITE[String(c.sameSite).toLowerCase()]
      all.push({
        name: c.name, value: c.value, domain: c.domain, path: typeof c.path === 'string' ? c.path : '/', secure: c.secure === true, httpOnly: c.httpOnly === true,
        expires: c.session !== true && typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate) : -1, ...(sameSite ? { sameSite } : {}),
      })
    }
  } else {
    for (const raw of trimmed.split('\n')) {
      const httpOnly = raw.startsWith('#HttpOnly_')
      const fields = (httpOnly ? raw.slice('#HttpOnly_'.length) : raw).replace(/\r$/, '').split('\t')
      if ((raw.startsWith('#') && !httpOnly) || fields.length < 7) continue
      const expires = Number(fields[4])
      all.push({ name: fields[5]!, value: fields.slice(6).join('\t'), domain: fields[0]!, path: fields[2]!, secure: fields[3] === 'TRUE', httpOnly, expires: expires > 0 ? expires : -1 })
    }
    if (!all.length) throw new Error('the cookie file is neither a JSON cookie export nor a Netscape cookie file')
  }
  const cookies = all.filter((c) => domainOf(c.domain!, domains))
  if (!cookies.length) throw new Error(`no cookie for ${domains[0]} in the file`)
  return { cookies, skipped: all.length - cookies.length }
}

export interface LoginReport {
  signedIn: boolean
  detail: string
  imported?: number
  skipped?: number
}

export interface LoginOptions {
  /** The contents of a cookie file; read once by the caller and never stored. */
  cookies?: string
  /** The `DISPLAY` for a manual sign-in; without it only cookies work. */
  display?: string
  /** Only for tests: which cookie domains to keep. */
  cookieDomains?: string[]
  /** How long a manual sign-in waits, in milliseconds; default 10 minutes. */
  waitMs?: number
}

/** Sign the profile in, by cookies or by hand in a visible window, then report whether it is signed in. A cookie value is never part of the report. */
export async function webLogin(web: WebConfig, options: LoginOptions = {}): Promise<LoginReport> {
  if (options.cookies === undefined && !options.display) throw new Error('no display is available for a manual sign-in (DISPLAY is not set): import cookies instead (system workers login <account> --cookies <file>)')
  const parsed = options.cookies === undefined ? undefined : parseCookies(options.cookies, options.cookieDomains)
  const context = await launch(web, parsed ? web.headless : false)
  try {
    // Chrome forgets a session cookie when it closes, and the next attempt is a new launch: give it a lifetime.
    const lifetime = Math.floor(Date.now() / 1000) + SESSION_COOKIE_DAYS * 86400
    if (parsed) await context.addCookies(parsed.cookies.map((c) => (c.expires === -1 ? { ...c, expires: lifetime } : c)))
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(web.url, { waitUntil: 'domcontentloaded', timeout: web.timeouts.load * 1000 })
    const deadline = Date.now() + (parsed ? 0 : options.waitMs ?? 10 * 60_000)
    let closed = false
    context.on('close', () => { closed = true })
    let state = await settle(page, web.timeouts.load * 1000, () => {})
    while (!parsed && state !== 'ready' && !closed && Date.now() < deadline) {
      await sleep(1000)
      state = await pageState(page)
    }
    // Let the session reach the profile before the window closes.
    if (state === 'ready' && !parsed) await sleep(3000)
    const imported = parsed ? { imported: parsed.cookies.length, skipped: parsed.skipped } : {}
    return state === 'ready' ? { signedIn: true, detail: 'signed in', ...imported } : { signedIn: false, detail: WHY[state], ...imported }
  } finally {
    await context.close().catch(() => {})
  }
}
