/**
 * The recheck of an Account that is not ready (WW6d): `system workers recheck <ref>`. It opens the profile headed on its own
 * Xvfb and runs what an attempt runs before it sends: the driver's `checkAuth`, the Chat mode and, when the Account asks for it,
 * the temporary chat. Nothing is typed and nothing is sent. The Account moves to `ready` only when they pass; it is the only way
 * out of `needs-sign-in` and `challenged`. What fails because of the Host (Chrome did not start, the profile is held) changes nothing.
 */
import type { BrowserContext } from 'patchright-core'
import { ProviderError } from '@system/web-driver'
import { chatGptDriver, launch, singleTab, type WebConfig } from './chatgpt.ts'
import { startXvfb } from './display.ts'
import { classify, type AccountHealth, type HealthState } from './health.ts'

export interface RecheckReport {
  ready: boolean
  /** The Account's state after the check. */
  state: HealthState
  detail: string
}

export interface RecheckOptions {
  /** Only for tests: the launcher (default `launch`). */
  launcher?: typeof launch
}

export async function recheck(web: WebConfig, health: AccountHealth, options: RecheckOptions = {}): Promise<RecheckReport> {
  const report = (ready: boolean, detail: string): RecheckReport => ({ ready, state: health.record.state, detail })
  const display = await startXvfb()
  let context: BrowserContext | undefined
  let reachedSite = false
  try {
    context = await (options.launcher ?? launch)(web, display)
    const { page } = await singleTab(context)
    page.setDefaultNavigationTimeout(web.timeouts.load * 1000)
    const driver = chatGptDriver(web)
    // The driver's own opening: the site's home, the sign-in state, Chat mode, and the temporary chat when asked; it types nothing.
    reachedSite = true
    await driver.open(page, { conversation: web.temporaryChat ? 'temporary' : 'persistent' })
    health.recheckPassed()
    return report(true, 'the Account is signed in, in Chat mode' + (web.temporaryChat ? ', in a temporary chat' : '') + '; nothing was sent')
  } catch (error) {
    const reason = (error as Error).message.split('\n')[0] ?? 'failed'
    // A refusal to open the page at all is the Host's; what the page showed moves the state as an attempt's failure does.
    if (reachedSite) health.failure({ failedStage: error instanceof ProviderError ? error.kind : undefined, reason, reachedSite })
    return report(false, reason + (reachedSite && !classify({ reason, reachedSite }) ? ' (the state is unchanged)' : ''))
  } finally {
    await context?.close().catch(() => {})
    await display.stop()
  }
}
