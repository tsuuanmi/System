/**
 * One headed Chrome on one private Xvfb for a whole test file (web-3b), instead of one of each per test. `page()` is a new tab with the
 * session of the previous test gone (cookies cleared; the fake sites are on different ports, so their storage never meets); `release(page)`
 * closes it, so a site's server does not wait for it. The Chrome and the Xvfb are stopped after the file. `starts` counts what was started.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import type { BrowserContext, Page } from 'patchright-core'
import { CHROME, skipHeaded } from '../../../test-support/headed.ts'
import { launch, webDefaults } from '../../runtime-web/src/chatgpt.ts'
import { startXvfb, type Display } from '../../runtime-web/src/display.ts'

export const starts = { xvfb: 0, chrome: 0 }
const root = mkdtempSync(join(tmpdir(), 'system-shared-chrome-'))
let display: Display | undefined
let context: BrowserContext | undefined
let launching: Promise<BrowserContext> | undefined

async function shared(): Promise<BrowserContext> {
  if (context) return context
  return (launching ??= (async () => {
    display = await startXvfb()
    starts.xvfb++
    context = await launch({ ...webDefaults(join(root, 'profile')), executablePath: CHROME }, display)
    starts.chrome++
    return context
  })())
}

/** The shared Chrome's context, for a test that closes pages itself. */
export async function sharedContext(): Promise<BrowserContext> {
  const c = await shared()
  await c.clearCookies()
  return c
}
/** A new tab of the shared Chrome. */
export async function page(): Promise<Page> {
  return (await sharedContext()).newPage()
}
/** Close `tab`; the Chrome stays. */
export const release = (tab: Page): Promise<void> => tab.close().catch(() => undefined)

after(async () => {
  await context?.close().catch(() => {})
  await display?.stop()
  rmSync(root, { recursive: true, force: true })
  if (process.env.SYSTEM_TEST_COUNT && !skipHeaded) console.error(`shared-chrome-starts xvfb=${starts.xvfb} chrome=${starts.chrome}`)
})
