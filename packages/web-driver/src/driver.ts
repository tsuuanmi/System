// Ported from System 1 (tsuuanmi/system @ f199a277): packages/plugins/provider-chatgpt-web/src/driver.ts. Changes: packages/web-driver/README.md.
/**
 * The ChatGPT Web provider driver (docs/design/provider-turns.md), what is left of it after the
 * turn went to the generic Procedures (WW2-iv): the sign-in check, the opening of a chat in Chat
 * mode, the page diagnostics and the shipped map, for the login and the recheck. Every
 * element, action, and state comes from `ui/chatgpt.ui.yaml` through the UI engine
 * (ADR-0021), so a UI change is a map change. Rules that are not UI:
 * - a new conversation starts in **Chat** mode, never Work (Work spends the Codex quota);
 * - one-shot turns run in Temporary chat; persistent turns bind `/c/<id>`.
 */
import { type OpenOptions, type AuthState, type DeleteOptions, ProviderError, type ProviderFeature, type ResearchState, type TurnSnapshot, sleep, splitAfterLastFence, withMissingSources } from './core/index.ts'
import { copiedMarkdown, type CopyRefusedEvent, type DriftEvent, type HealEvent, deletionUnverified, inspectConversationMenu, linksIn, pageIdle, preWrapText, shippedMapOf, shippedMapProblemOf, UiEngine, type UiMap, type UiOutline } from './ui-ops/index.ts'
import type { Frame, Locator, Page, Route } from 'patchright-core'

/** How long the logged-out home must hold, with no composer, before it counts as signed out. */
const LOGGED_OUT_HOLD_MS = 3000

export interface DriverTimeouts {
  pollMs?: number
  /** Page readiness after navigation (default 30 s). */
  readyMs?: number
  /** How long a reopened conversation may take to render before it counts as not observed (default 20 s). */
  snapshotMs?: number
  /** How long the Chat/Work switch may take to render (default: the map's `settings.modeReadyMs`). */
  modeReadyMs?: number
  /** How long the mode the switch shows must hold (default: the map's `settings.modeSettleMs`). */
  modeSettleMs?: number
}

/** The stages `open` runs, as `onStage` reports them. */
export type TurnStage = 'open' | 'auth'
export interface StageEvent {
  stage: TurnStage
  status: 'start' | 'ok' | 'failed'
  /** The first line of the failure, for `failed`. */
  error?: string
}

/** What `diagnostics` keeps of a page: bounded, with no cookie, token, input value or text: lengths stand for text and values. */
export interface PageDiagnostics {
  url: string
  viewport: { width: number; height: number }
  uiMap: { revision: string; hash: string }
  dom: string
  truncated: boolean
}
const DIAGNOSTIC_DOM_CHARS = 20_000

export interface DriverOptions {
  /** Site origin; tests point it at a local fake (default https://chatgpt.com). */
  origin?: string
  /** Local overlay text (`<DSH_HOME>/system/ui/chatgpt.overlay.yaml`). */
  overlay?: string
  timeouts?: DriverTimeouts
  /** The account's page opens are spaced at least this far apart (default 10 s, ADR-0030). */
  pageGapMs?: number
}

/** Sign-in steps run on signed-out pages, where the map's sign-out guard would always fire. */
const NO_GUARDS = { guards: false } as const

const MAP_URL = new URL('../ui/chatgpt.ui.yaml', import.meta.url)
const CONVERSATION = /^\/c\/([0-9a-f-]{36})(?:[/?#]|$)/
/** Every request that could delete or change a conversation: during a deletion only the bound one's deletion passes. */
const DELETE_REQUEST = /\/backend-api\/conversations?(?:\/[^?#]*)?(?:[?#]|$)/

/** The shipped map, with an optional local overlay merged after it; read and validated when this package loads, never again (WW6f). */
export function shippedMap(overlay?: string): UiMap {
  return shippedMapOf(MAP_URL, overlay)
}

/** Why the shipped map did not load (one line), if it did not: the web-worker row reports its accounts unavailable with it. */
export const shippedMapProblem = (file: URL = MAP_URL): string | undefined => shippedMapProblemOf(file)
shippedMapProblem()

/** The tools popover entry that proves each account feature. */
const FEATURE_ENTRIES = [['deep-research', 'tools.deep-research'], ['web-search', 'tools.web-search'], ['image-generation', 'tools.create-image']] as const

/** Where a Deep research report was read: its frame, or inline as the last answer. */
type ReportPath = 'frame' | 'inline'

/** The failures that are the site's own error page, which `open` loads once more. */
const SITE_ERROR_PAGES = new WeakSet<object>()
function siteErrorPage(): ProviderError {
  const error = new ProviderError('overloaded', 'chatgpt-web: the site shows its own error page instead of the app; nothing was sent')
  SITE_ERROR_PAGES.add(error)
  return error
}

export class ChatGptWebDriver {
  readonly provider = 'chatgpt-web'
  /** The site's name for people: its Workers' display name starts with it (the roster). */
  readonly title = 'ChatGPT'
  readonly capabilities = ['reason', 'persistent-conversation'] as const
  /** Account features, each proven on the account by `probeFeatures` (REQ-PRV-7). */
  readonly features = ['deep-research', 'web-search', 'image-generation'] as const
  /** Conversations `deleteConversation` deletes; a Deep research one waits for its live check (PROP-0004 Phase 5). */
  readonly deletes = ['chat', 'web-search'] as const
  readonly loginUrl: string
  /**
   * Copies of chatgpt-main's session died (live 2026-10-17, twice: after six days, then about 9 h
   * after a Save) while its login profile stayed signed in: the account works in its own login
   * profile (ADR-0030), as Gemini's does.
   */
  readonly sessionBound = true
  readonly pageGapMs: number
  readonly stateOrigins: readonly string[]
  readonly map: UiMap
  onDrift: ((event: DriftEvent) => void) | undefined
  /** An answer's Copy that was not kept, so it was read as rendered text: counts only; the plugin records it (`provider.copy-refused`). */
  onCopyRefused: ((event: CopyRefusedEvent) => void) | undefined
  onHeal: ((event: HealEvent) => void) | undefined
  /** Records a chosen heal before it acts (INV-13); a throw aborts the action. */
  beforeHealedAction: ((event: HealEvent) => void | Promise<void>) | undefined
  /** Whether self-heal may run; the plugin turns it off when no decision store exists. */
  healEnabled: () => boolean = () => true
  /** Each stage of a turn as it starts and ends; the Runtime writes it into its evidence record. */
  onStage: ((event: StageEvent) => void) | undefined
  private readonly origin: string
  private readonly timeouts: Required<Omit<DriverTimeouts, 'modeReadyMs' | 'modeSettleMs'>> & Pick<DriverTimeouts, 'modeReadyMs' | 'modeSettleMs'>
  private readonly engines = new WeakMap<Page, UiEngine>()

  constructor(options: DriverOptions = {}) {
    this.map = shippedMap(options.overlay)
    this.origin = (options.origin ?? 'https://chatgpt.com').replace(/\/$/, '')
    this.loginUrl = `${this.origin}/auth/login`
    this.stateOrigins = [this.origin]
    this.pageGapMs = options.pageGapMs ?? 10_000
    this.timeouts = { pollMs: 250, readyMs: 30_000, snapshotMs: 20_000, ...options.timeouts }
  }

  /**
   * Signed in (composer present), signed out (positive evidence only), or unknown. The site's own
   * error page in place of the app is none of them: `overloaded`, a transient failure.
   */
  async checkAuth(page: Page): Promise<AuthState> {
    if (!page.url().startsWith(this.origin)) await page.goto(`${this.origin}/`, { waitUntil: 'domcontentloaded' })
    const engine = this.engine(page)
    try {
      await engine.waitFor({ anyOf: [{ state: 'auth.signed-in' }, { state: 'auth.signed-out' }, { state: 'auth.challenge' }, { state: 'site.error-page' }] }, this.timeouts.readyMs)
    } catch {
      // Neither state: whatever the page shows instead is outlined as drift evidence, so it can be
      // read without opening the operator's browser.
      await engine.drift('composer.input').catch(() => undefined)
      return 'unknown'
    }
    // A challenge page is neither: only the operator can pass it, and loading again deepens it.
    if (await engine.state('auth.challenge')) throw new ProviderError('challenge', 'chatgpt-web: the site shows a challenge (Verify you are human); pass it in the login profile (system account login) and Save')
    if (await engine.state('site.error-page')) throw siteErrorPage()
    if (!(await engine.state('auth.signed-out'))) return 'signed-in'
    if (await engine.state('auth.login-page')) return 'signed-out'
    // Only the logged-out home: a signed-in app may paint that shell before it loads its session, and
    // a false sign-out takes the operator to undo. It counts only if no composer appears meanwhile.
    if (await engine.waitFor({ state: 'auth.signed-in' }, LOGGED_OUT_HOLD_MS).then(() => true, () => false)) return 'signed-in'
    if (await engine.state('auth.signed-out')) return 'signed-out'
    await engine.drift('composer.input').catch(() => undefined)
    return 'unknown'
  }

  /**
   * The signed-in account's id, observed passively from the page's own account request
   * (the map's `account.me` signal). The page is reloaded so the request happens again;
   * nothing is requested by the driver itself. Only a hash of the result is ever stored.
   */
  async identity(page: Page): Promise<string> {
    const pattern = this.map.network['account.me']
    if (!pattern) throw new ProviderError('config_error', 'chatgpt-web: the UI map has no account.me signal')
    const url = new RegExp(pattern.url)
    const response = page.waitForResponse((r) => r.request().method() === (pattern.method ?? 'GET') && url.test(new URL(r.url()).pathname), { timeout: this.timeouts.readyMs })
    await page.reload({ waitUntil: 'domcontentloaded' })
    const body = (await (await response).json().catch(() => ({}))) as { id?: unknown }
    if (typeof body.id !== 'string' || !body.id) throw new ProviderError('ui_drift', 'chatgpt-web: the account response carried no id')
    return `${this.provider}:${body.id}`
  }

  async probeFeatures(page: Page): Promise<string[]> {
    await this.open(page, { conversation: 'persistent' })
    const engine = this.engine(page)
    await engine.act('tools.open')
    const found: string[] = []
    for (const [feature, element] of FEATURE_ENTRIES) if ((await engine.count(element)) > 0) found.push(feature)
    await page.keyboard.press('Escape')
    return found
  }

  /** Navigate to a new or bound conversation in the requested mode. */
  async open(page: Page, options: OpenOptions): Promise<void> {
    await this.reach(page, options)
    await this.enterMode(page, this.engine(page), options)
  }

  /** Load the conversation's page and require a signed-in app on it. */
  private async reach(page: Page, options: OpenOptions): Promise<void> {
    if (options.conversation === 'temporary' && options.binding !== undefined) {
      throw new ProviderError('invalid_input', 'chatgpt-web: a temporary turn has no conversation to continue')
    }
    const url = options.binding ? `${this.origin}/c/${options.binding}` : `${this.origin}/`
    // A kept tab already showing the conversation is checked as it is, never loaded again (ADR-0030).
    await this.staged('open', async () => {
      if (!(options.binding && (await this.showing(page, options.binding)))) await page.goto(url, { waitUntil: 'domcontentloaded' })
    })
    await this.staged('auth', async () => {
      // The site's own error page in place of the app (live, a fresh profile's first page): nothing
      // is typed yet, so it is loaded once more; a second one fails as transient.
      const auth = await this.checkAuth(page).catch(async (error: unknown) => {
        if (!SITE_ERROR_PAGES.has(error as object)) throw error
        await page.reload({ waitUntil: 'domcontentloaded' })
        return this.checkAuth(page)
      })
      if (auth === 'signed-out') throw new ProviderError('reauth_required', 'chatgpt-web: signed out')
      // Neither signed in nor signed out (outlined as drift): loading it again on this account only adds traffic.
      if (auth === 'unknown') throw new ProviderError('ui_drift', 'chatgpt-web: the page showed neither the composer nor a sign-in page in time (outlined as a ui.drift of composer.input)')
    })
  }

  /** Chat on the home page (a temporary chat when asked), or kept in a bound conversation. */
  private async enterMode(page: Page, engine: UiEngine, options: OpenOptions): Promise<void> {
    if (!options.binding) {
      // A new conversation: Chat must be selected on the home page first, once the switch is there.
      await this.awaitModeSwitch(engine)
      await this.ensureChat(engine, 'on the home page')
      if (options.conversation === 'temporary') await engine.act('temporary.enable')
    } else if ((await engine.count('mode.group')) > 0) {
      await this.ensureChat(engine, 'in the bound conversation')
    }
    await this.requireChat(engine, 'after opening the conversation')
  }

  /**
   * Wait for the Chat/Work switch, which the site renders after the composer; a missing switch is
   * never read as Chat mode. Once shown, the mode it reads must hold for `modeSettleMs`, sampled every poll (a site that
   * restores its last mode late changes it under us); a change starts the hold again, and the whole wait ends at `modeReadyMs`. At the deadline
   * the page's state is named: a challenge, a signed-out page, or a mode unknown.
   */
  private async awaitModeSwitch(engine: UiEngine): Promise<void> {
    const readyMs = this.timeouts.modeReadyMs ?? this.map.settings.modeReadyMs
    const settleMs = this.timeouts.modeSettleMs ?? this.map.settings.modeSettleMs
    const deadline = Date.now() + readyMs
    // The mode is sampled every poll: any change (or the switch going) starts the hold again; the whole wait ends at the deadline.
    let seen: string | undefined
    let since = 0
    // Each page operation ends at the deadline too: one that hangs is a sample that never came (`undefined`). Naming the page's state afterwards gets a one-second window of its own.
    const bounded = async <T>(run: Promise<T>, until = deadline): Promise<T | undefined> => {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([run.catch(() => undefined), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, until - Date.now())) })])
      } finally {
        clearTimeout(timer)
      }
    }
    while (Date.now() < deadline) {
      const shown = ((await bounded(engine.count('mode.group'))) ?? 0) > 0
      // Only a mode that is known (pressed or not) can hold: an unreadable one is as good as no switch.
      const now = shown ? await bounded(this.pressed(engine)) : undefined
      if (now !== 'true' && now !== 'false') seen = undefined
      else if (seen === undefined || now !== seen) { seen = now; since = Date.now() }
      else if (Date.now() - since >= settleMs && Date.now() <= deadline) return
      await sleep(Math.max(0, Math.min(this.timeouts.pollMs, deadline - Date.now())))
    }
    if (await bounded(engine.state('auth.challenge'), Date.now() + 1000)) throw new ProviderError('challenge', 'chatgpt-web: the site shows a challenge while the Chat/Work switch is awaited; nothing was sent')
    if (await bounded(engine.state('auth.signed-out'), Date.now() + 1000)) throw new ProviderError('reauth_required', 'chatgpt-web: signed out while the Chat/Work switch was awaited')
    throw new ProviderError('ui_drift', `chatgpt-web: mode unknown: the Chat/Work switch did not appear within ${readyMs / 1000} s (or its mode kept changing); refusing to start a conversation in an unknown mode`)
  }

  /** A stage of a turn, reported to `onStage` as it starts and ends. */
  private async staged<T>(stage: TurnStage, run: () => Promise<T>): Promise<T> {
    this.onStage?.({ stage, status: 'start' })
    try {
      const result = await run()
      this.onStage?.({ stage, status: 'ok' })
      return result
    } catch (error) {
      this.onStage?.({ stage, status: 'failed', error: (error as Error).message.split('\n')[0] ?? '' })
      throw error
    }
  }

  /**
   * What the page shows, for a failure nobody watched: its URL without query, the viewport, the UI
   * map's version, and the DOM's structure (tags, roles, aria-labels, data-testid, attribute names) with
   * scripts, styles and input values taken out and every text node and other attribute value (URLs
   * included) replaced by its length (`[text:42]`), cut to a fixed size. No cookie or storage is read.
   */
  async diagnostics(page: Page): Promise<PageDiagnostics> {
    const captured = await page.evaluate((limit) => {
      const root = document.documentElement.cloneNode(true) as HTMLElement
      root.querySelectorAll('script,style,noscript,svg,link,meta,template,iframe').forEach((el) => el.remove())
      root.querySelectorAll('input,textarea,select,[contenteditable]').forEach((el) => { el.textContent = '' })
      // Structure only: tags, attribute names, and the values of role, aria-label and data-testid; every other value and every text node is its length.
      for (const el of [root, ...root.querySelectorAll('*')]) {
        for (const attr of [...el.attributes]) {
          if (/^(on|style$|value$|checked$|srcset$)/.test(attr.name)) el.removeAttribute(attr.name)
          else if (!/^(role|aria-label|data-testid)$/.test(attr.name) && attr.value !== '') el.setAttribute(attr.name, `[text:${attr.value.length}]`)
        }
      }
      const texts = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = texts.nextNode(); node; node = texts.nextNode()) if ((node.nodeValue ?? '').trim() !== '') node.nodeValue = `[text:${node.nodeValue!.length}]`
      const html = root.outerHTML
      return { html: html.slice(0, limit), truncated: html.length > limit, width: window.innerWidth, height: window.innerHeight }
    }, DIAGNOSTIC_DOM_CHARS)
    const at = new URL(page.url(), this.origin)
    return { url: `${at.origin}${at.pathname}`, viewport: { width: captured.width, height: captured.height }, uiMap: { revision: this.map.uiRevision, hash: this.map.hash }, dom: captured.html, truncated: captured.truncated }
  }

  /** The page shows `binding` already: its URL is the conversation's, and its turns are rendered. */
  private async showing(page: Page, binding: string): Promise<boolean> {
    return this.bindingOf(page) === binding && (await this.engine(page).count('turn.user')) > 0
  }

  /** Nothing generating, no dialog or menu open: a session-bound account keeps the page for the session's next turn. */
  async pageIdle(page: Page): Promise<boolean> {
    return pageIdle(this.engine(page))
  }

  /** Select Chat if it is not already the pressed mode, then require it. */
  private async ensureChat(engine: UiEngine, when: string): Promise<void> {
    if ((await this.pressed(engine)) !== 'true') await engine.act('mode.select-chat')
    await this.requireChat(engine, when)
  }

  /**
   * Reopen a bound conversation and report what it shows, for reconciliation. Only positive
   * evidence counts: a page that has not rendered a user turn was not observed, and for Deep
   * research only the run after the last prompt counts, never its acknowledgement.
   */
  async snapshot(page: Page, binding: string, options: { feature?: ProviderFeature } = {}): Promise<TurnSnapshot> {
    await page.goto(`${this.origin}/c/${binding}`, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'chatgpt-web: signed out')
    if (auth === 'unknown' || this.bindingOf(page) !== binding) return { text: '', running: false, observable: false }
    const engine = this.engine(page)
    const rendered = await engine.waitFor({ visible: 'turn.user' }, this.timeouts.snapshotMs).then(() => true, () => false)
    if (!rendered) return { text: '', running: false, observable: false }
    const lastPrompt = await this.promptText(engine)
    if (options.feature === 'deep-research') {
      const deadline = Date.now() + this.timeouts.snapshotMs
      for (;;) {
        const research = await this.researchState(page, engine)
        if (research.done && research.text) return { text: research.text, running: false, observable: true, lastPrompt }
        if (research.running) return { text: '', running: true, observable: true, lastPrompt }
        // No readable run after the prompt yet (frames load late), or a clarifying question.
        if (Date.now() > deadline) return { text: '', running: false, observable: false, lastPrompt }
        await page.waitForTimeout(500)
      }
    }
    await engine.waitFor({ visible: 'turn.assistant' }, 5000).catch(() => undefined)
    const text = (await engine.count('turn.assistant')) > 0 ? await this.answerText(engine) : ''
    return { text, running: await engine.state('turn.running'), observable: true, lastPrompt }
  }

  /**
   * Delete one bound conversation from its own menu: it must open as exactly that conversation
   * (its id in the URL, its turns shown) before anything is clicked, and the page must still be on
   * it when the deletion is confirmed. Reopening it must then show that it no longer exists.
   */
  async deleteConversation(page: Page, binding: string, options: DeleteOptions = {}): Promise<'deleted' | 'gone'> {
    const before = await this.openConversation(page, binding)
    if (before === 'missing') return 'gone'
    if (options.confirmed) {
      throw new ProviderError('session_broken', before === 'shown'
        ? `chatgpt-web: conversation ${binding} still opens after a deletion was confirmed; it is not clicked again`
        : `chatgpt-web: conversation ${binding} could not be checked after a deletion was confirmed (the page showed neither it nor that it is gone); it is not clicked again`)
    }
    if (before === 'unknown') throw new ProviderError('ui_drift', `chatgpt-web: conversation ${binding} did not open as itself; nothing was deleted`)
    const engine = this.engine(page)
    // Exactly the conversation's own path before every click: a redirect or a dialog never points a click at another chat.
    const guard = (): void => {
      if (new URL(page.url()).pathname !== `/c/${binding}`) throw new ProviderError('ui_drift', `chatgpt-web: the page left conversation ${binding} before the deletion was confirmed; nothing was deleted`)
    }
    // At the network too: a deletion that names any other conversation, or that is not a deletion, never leaves the page.
    const own = `/backend-api/conversation/${binding}`
    const block = async (route: Route): Promise<void> => {
      const request = route.request()
      const body = (() => {
        try {
          return JSON.parse(request.postData() ?? '{}') as { is_visible?: unknown }
        } catch {
          return {}
        }
      })()
      const reads = request.method() === 'GET' || request.method() === 'HEAD'
      if (reads || (request.method() === 'PATCH' && new URL(request.url()).pathname === own && body.is_visible === false)) await route.continue()
      else await route.abort('blockedbyclient')
    }
    await page.route(DELETE_REQUEST, block)
    try {
      guard()
      await engine.act('conversation.open-options')
      guard()
      await engine.act('conversation.choose-delete')
      guard()
      await options.beforeConfirm?.()
      await engine.act('conversation.confirm-delete')
    } finally {
      await page.unroute(DELETE_REQUEST, block).catch(() => undefined)
    }
    // The site leaves the deleted conversation on its own; reopening it before then is aborted.
    await page.waitForURL((url) => CONVERSATION.exec(url.pathname)?.[1] !== binding, { timeout: this.timeouts.snapshotMs, waitUntil: 'domcontentloaded' }).catch(() => undefined)
    if ((await this.openConversation(page, binding)) === 'missing') return 'deleted'
    throw new ProviderError('session_broken', `chatgpt-web: conversation ${binding} still opens after its deletion`)
  }

  /** The deletion's map entries not yet checked on the live site: while any is, nothing is deleted. */
  deletionUnverified(): string[] {
    return deletionUnverified(this.map)
  }

  /**
   * Outline a conversation's page and its own menu, choosing nothing: the evidence that fixes the
   * deletion's map entries without opening the operator's browser. The menu is closed with Escape.
   */
  async inspectConversation(page: Page, binding: string): Promise<UiOutline[]> {
    return inspectConversationMenu(page, this.engine(page), await this.openConversation(page, binding))
  }

  /** Open a bound conversation: shown as itself (its own path, its turns), positively missing, or neither. */
  private async openConversation(page: Page, binding: string): Promise<'shown' | 'missing' | 'unknown'> {
    if (!/^[0-9a-f-]{36}$/.test(binding)) throw new ProviderError('invalid_input', `chatgpt-web: ${binding} is not a conversation id`)
    await page.goto(`${this.origin}/c/${binding}`, { waitUntil: 'domcontentloaded' })
    const auth = await this.checkAuth(page)
    if (auth === 'signed-out') throw new ProviderError('reauth_required', 'chatgpt-web: signed out')
    if (auth === 'unknown') return 'unknown'
    const engine = this.engine(page)
    await engine.waitFor({ anyOf: [{ visible: 'turn.user' }, { visible: 'conversation.missing' }] }, this.timeouts.snapshotMs).catch(() => undefined)
    if (await engine.count('conversation.missing')) {
      // Positive only when it holds again after a reload: a load that failed once is not a deletion.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await engine.waitFor({ anyOf: [{ visible: 'turn.user' }, { visible: 'conversation.missing' }] }, this.timeouts.snapshotMs).catch(() => undefined)
      return (await engine.count('conversation.missing')) && !(await engine.count('turn.user')) ? 'missing' : 'unknown'
    }
    return new URL(page.url()).pathname === `/c/${binding}` && (await engine.count('turn.user')) > 0 ? 'shown' : 'unknown'
  }

  /** Text of the last user turn: the container of its "You said:" heading. */
  private async promptText(engine: UiEngine): Promise<string> {
    const heading = (await engine.resolve('turn.user', 1000)).locator.last()
    const raw = await heading.locator('xpath=..').innerText().catch(() => '')
    return raw.replace(/^\s*You said:?\s*/i, '').trim()
  }

  /**
   * The frames of the Deep research run that belongs to the last prompt: the last run host,
   * if it follows the last user turn, and every frame nested in it. A session can hold
   * several runs; an earlier run's frames never count.
   */
  private async researchFrames(engine: UiEngine): Promise<Frame[]> {
    if ((await engine.count('research.host')) === 0) return []
    const host = (await engine.resolve('research.host', 1000)).locator.last()
    if ((await engine.count('turn.user')) > 0) {
      const user = await (await engine.resolve('turn.user', 1000)).locator.last().elementHandle()
      const after = await host.evaluate((h, u) => !!u && (u.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, user).catch(() => false)
      if (!after) return []
    }
    const frame = await (await host.elementHandle().catch(() => null))?.contentFrame()
    if (!frame) return []
    const frames = [frame]
    for (let i = 0; i < frames.length; i++) frames.push(...frames[i]!.childFrames())
    return frames
  }

  /**
   * The run of the last prompt: in its report frame (live layout of 2026-10-12), or inline as the
   * last answer, when the run shows no frame or its frame no report (the app shell seen live on
   * 2026-10-18, whose report sits in the conversation with its own Copy). `ack` is the run's
   * acknowledgement, when known: the report is never it.
   */
  private async researchState(page: Page, engine: UiEngine, ack?: string): Promise<ResearchState & { path?: ReportPath }> {
    for (const frame of await this.researchFrames(engine)) {
      if (await engine.findIn('research.completed', frame)) {
        const framed = await this.reportText(engine, frame)
        if (framed) return { running: false, done: true, text: framed, path: 'frame' }
        return { running: false, done: true, text: await this.inlineReport(page, engine, { ack }), path: 'inline' }
      }
      if (await engine.findIn('research.running', frame)) return { running: true, done: false, text: '' }
    }
    const marker = await this.afterPrompt(engine, 'research.completed')
    if (marker) return { running: false, done: true, text: await this.inlineReport(page, engine, { marker, ack }), path: 'inline' }
    if (await this.runningAfterPrompt(engine)) return { running: true, done: false, text: '' }
    return { running: false, done: false, text: '' }
  }

  /**
   * Whether the page shows a run going on: outside the conversation's thread (a panel, live
   * 2026-10-19, while the thread showed only the acknowledgement), or in the thread after the
   * last prompt (an earlier run's never counts). Running only ever means wait for the report,
   * which is read in the thread.
   */
  private async runningAfterPrompt(engine: UiEngine): Promise<boolean> {
    // One look, never two: a marker that left the page meanwhile (the run just finished) is not
    // running, and never drift (a count, then a resolve, failed the turn as its report landed).
    const found = await engine.resolve('research.running', 0).then((r) => r.locator, () => undefined)
    if (!found) return false
    const thread = await engine.resolve('conversation.thread', 1000).then((t) => t.locator.first().elementHandle(), () => null)
    const user = (await engine.count('turn.user')) > 0 ? await (await engine.resolve('turn.user', 1000)).locator.last().elementHandle() : null
    return found.evaluateAll((markers, [t, u]) => markers.some((m) => !t || !t.contains(m) || !u || (u.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0), [thread, user] as const).catch(() => false)
  }

  /**
   * The last `id` in the conversation's thread, if it follows the last prompt (an earlier run's
   * never counts, nor anything outside the thread, such as a floating copy of the conversation).
   */
  private async afterPrompt(engine: UiEngine, id: string): Promise<Locator | undefined> {
    const thread = await engine.resolve('conversation.thread', 1000).catch(() => undefined)
    if (!thread) return undefined
    const inThread = await engine.findIn(id, thread.locator.first())
    if (!inThread) return undefined
    const found = inThread.locator.last()
    if ((await engine.count('turn.user')) === 0) return found
    const user = await (await engine.resolve('turn.user', 1000)).locator.last().elementHandle()
    return (await found.evaluate((f, u) => !!u && (u.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, user).catch(() => false)) ? found : undefined
  }

  /**
   * The report as the last answer, read as an answer is (its own Copy, else the rendered text with
   * its links). With the run marked complete in the page, only the answer that holds or follows
   * the mark (the acknowledgement comes before it); marked complete in its frame only, only an
   * answer that is not the acknowledgement.
   */
  private async inlineReport(page: Page, engine: UiEngine, run: { marker?: Locator; ack?: string | undefined }): Promise<string> {
    if ((await engine.count('turn.assistant')) === 0) return ''
    const answer = (await engine.resolve('turn.assistant', 1000)).locator.last().locator('xpath=..')
    const rendered = await this.answerText(engine)
    if (run.marker) {
      // The page marks the run complete: the report is the answer that holds or follows the mark.
      const marker = await run.marker.elementHandle()
      const after = await answer.evaluate((a, m) => !!m && (a.contains(m) || (m.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0), marker).catch(() => false)
      if (!after) return ''
    } else {
      // Marked complete in its frame only: never the acknowledgement, and never without knowing it.
      const same = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
      if (run.ack === undefined || same(rendered, run.ack)) return ''
    }
    // Its citations may stand outside the answer's own container (inline source pills): every
    // link to another site after the prompt, in the conversation, follows the report as a source.
    return withMissingSources((await this.markdownOf(page, rendered)).text, await this.linksAfterPrompt(engine))
  }

  /** The links to another site after the last prompt, within its conversation (href → text, first text wins). */
  private async linksAfterPrompt(engine: UiEngine): Promise<Map<string, string>> {
    if ((await engine.count('turn.user')) === 0) return new Map()
    const user = (await engine.resolve('turn.user', 1000)).locator.last()
    const found = await user.evaluate((u) => {
      const scope = u.closest('[role="region"]') ?? document.body
      return [...scope.querySelectorAll('a[href]')]
        .filter((a) => (u.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
        .map((a) => [(a as HTMLAnchorElement).href, (a.textContent ?? '').trim()] as const)
        .filter(([href]) => /^https?:/.test(href) && new URL(href).origin !== location.origin)
    }).catch(() => [] as Array<readonly [string, string]>)
    const links = new Map<string, string>()
    for (const [href, text] of found) if (!links.has(href)) links.set(href, text)
    return links
  }

  private bindingOf(page: Page): string | undefined {
    const url = new URL(page.url())
    return CONVERSATION.exec(url.pathname + url.search)?.[1]
  }

  /**
   * Credential sign-in on the current (signed-out) page: email, password, then whatever second
   * step appears. Steps are recognized from the UI map, never by guessing; a challenge, an
   * unknown page, or a third code fails closed, so the account is never locked.
   */
  async signIn(page: Page, credentials: { email: string; password: string }, code: (kind: 'totp' | 'email') => Promise<string>): Promise<void> {
    if (!page.url().startsWith(this.origin) && !/auth/.test(page.url())) await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' })
    else if ((await this.checkAuth(page)) === 'signed-out' && (await this.engine(page).count('login.email')) === 0) await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded' })
    const deadline = Date.now() + 3 * 60_000
    let submissions = 0
    let idleSince = Date.now()
    for (;;) {
      const engine = this.engine(page)
      if (Date.now() > deadline) throw new ProviderError('reauth_required', 'chatgpt-web: sign-in did not finish in time; use the remote login')
      if ((await engine.count('login.challenge')) > 0) throw new ProviderError('challenge', 'chatgpt-web: the sign-in shows a challenge; it is never solved automatically')
      if ((await engine.count('composer.input')) > 0) return
      let acted = true
      if ((await engine.count('login.code')) > 0) {
        if (submissions >= 2) throw new ProviderError('reauth_required', 'chatgpt-web: two codes were not accepted; stopping before the account is locked')
        const kind = (await engine.count('login.email-code-hint')) > 0 ? 'email' : 'totp'
        await engine.act('login.fill-code', { text: await code(kind) }, NO_GUARDS)
        submissions++
        await engine.act('login.submit-code', {}, NO_GUARDS)
      } else if ((await engine.count('login.password')) > 0) {
        await engine.act('login.fill-password', { text: credentials.password }, NO_GUARDS)
        await engine.act('login.submit-password', {}, NO_GUARDS)
      } else if ((await engine.count('login.email')) > 0) {
        await engine.act('login.fill-email', { text: credentials.email }, NO_GUARDS)
        await engine.act('login.submit-email', {}, NO_GUARDS)
      } else if ((await engine.count('login.try-another')) > 0) {
        await engine.act('login.choose-another', {}, NO_GUARDS)
        await engine.act('login.choose-authenticator', {}, NO_GUARDS)
      } else if ((await engine.count('login.not-now')) > 0) {
        await (await engine.resolve('login.not-now')).locator.click()
      } else {
        acted = false
      }
      if (acted) idleSince = Date.now()
      else if (Date.now() - idleSince > 15_000) throw new ProviderError('reauth_required', `chatgpt-web: unknown sign-in page (${new URL(page.url()).pathname}); use the remote login`)
      await page.waitForLoadState('domcontentloaded').catch(() => undefined)
      await new Promise((done) => setTimeout(done, 300))
    }
  }

  engine(page: Page): UiEngine {
    let engine = this.engines.get(page)
    if (!engine) {
      engine = new UiEngine(page, this.map, {
        onDrift: (event) => this.onDrift?.(event),
        onCopyRefused: (event) => this.onCopyRefused?.(event),
        onHeal: (event) => this.onHeal?.(event),
        beforeHealedAction: (event) => this.beforeHealedAction?.(event),
        heal: this.healEnabled(),
      })
      this.engines.set(page, engine)
    }
    return engine
  }

  private async pressed(engine: UiEngine): Promise<string | null> {
    const chat = await engine.resolve('mode.chat', 2000).catch(() => undefined)
    return chat ? chat.locator.getAttribute('aria-pressed') : null
  }

  /** Where the mode switch is shown, Chat must be the pressed one. */
  private async requireChat(engine: UiEngine, when: string): Promise<void> {
    if ((await engine.count('mode.group')) === 0) return
    if ((await this.pressed(engine)) !== 'true') {
      throw new ProviderError('ui_drift', `chatgpt-web: Chat mode is not selected ${when}; refusing to use Work (Codex quota)`)
    }
  }

  private async reportText(engine: UiEngine, frame: Frame): Promise<string> {
    const title = await engine.findIn('research.report-title', frame)
    if (!title) return ''
    const report = title.locator.locator('xpath=..')
    const text = (await report.innerText().catch(() => '')).trim()
    if (!text) return text
    const links = await linksIn(report)
    for (const [href, label] of await this.linksAfterPrompt(engine)) if (!links.has(href)) links.set(href, label)
    return withMissingSources(text, links)
  }

  /**
   * Text of the last assistant answer: the container of its "ChatGPT said:" heading. It is read
   * under `white-space: pre-wrap`, so runs of spaces survive (rendering collapses them, which
   * would strip the indentation from code in a tool call's arguments).
   */
  private async answerText(engine: UiEngine): Promise<string> {
    const heading = (await engine.resolve('turn.assistant', 1000)).locator.last()
    return (await preWrapText(heading.locator('xpath=..'))).replace(/^\s*ChatGPT said:?\s*/i, '').trim()
  }

  /**
   * The answer as the Markdown that was streamed (REQ-PRV-5), from its own Copy button: read from
   * the clipboard, and kept only when its words are the rendered answer's words (the clipboard
   * may be shared). Otherwise the rendered text stands, followed by the answer's cited links.
   */
  private async markdownOf(page: Page, rendered: string): Promise<{ text: string; blocks: Array<{ label: string; code: string }> }> {
    const engine = this.engine(page)
    const text = await copiedMarkdown(engine, rendered, async () => (await engine.resolve('turn.assistant.done', 1000)).locator.last(), async (markdown) => {
      // Copy rebuilds code blocks from the page and loses their line breaks: take each block's
      // text from its rendered element instead, or keep the rendered answer if they do not pair.
      const [fenced, rest] = splitAfterLastFence(markdown)
      const fences = fencedBlocks(fenced)
      if (!fences.length) return markdown.trim()
      const blocks = await this.renderedBlocks(engine)
      if (blocks.length !== fences.length) return rendered
      // The live Copy (2026-11-07) drops a block's info string: the block's own header names it.
      let at = 0
      let out = ''
      fences.forEach((fence, index) => {
        const block = blocks[index]!
        out += fenced.slice(at, fence.start) + fencedText(fence.info || block.label, block.code)
        at = fence.end
      })
      return `${out}${fenced.slice(at)}${rest}`.trim()
    }, async () => (await engine.resolve('turn.assistant', 1000)).locator.last().locator('xpath=..'))
    // A block's own fence lines (its content) do not make the text Markdown: a block still needs its fence when none of that name is in the text.
    const blocks = await this.renderedBlocks(engine)
    const unfenced = blocks.some(({ label }) => !new RegExp(`^\\s{0,3}(?:\`{3,}|~{3,})\\s*${escapeRegExp(label)}\\s*$`, 'm').test(text))
    return { text: unfenced ? this.withFencedBlocks(blocks, text) : text, blocks }
  }

  /**
   * An answer whose text lost its fences (Copy not used, empty, or its blocks not paired with the
   * page's): each rendered code block (`answer.code`, the block's header as its info string) is
   * written as a fenced block again, in place where the text still carries it, else after the text.
   * Not in System 1's driver as such: it kept Markdown fences only when Copy worked (W8).
   */
  private withFencedBlocks(blocks: Array<{ label: string; code: string }>, text: string): string {
    let result = text
    for (const { label, code: body } of blocks) {
      const fenced = fencedText(label, body)
      const where = new RegExp(`${label ? `${escapeRegExp(label)}[ \\t]*\\n+` : ''}${escapeRegExp(body)}`)
      result = where.test(result) ? result.replace(where, () => fenced) : `${result}\n\n${fenced}`
    }
    return result
  }

  /** The final answer's rendered code blocks: each one's text, rows kept, and its header's label as the info string. */
  private async renderedBlocks(engine: UiEngine): Promise<Array<{ label: string; code: string }>> {
    const answer = (await engine.resolve('turn.assistant', 1000)).locator.last().locator('xpath=..')
    const code = await engine.findIn('answer.code', answer).catch(() => undefined)
    if (!code) return []
    return code.locator.evaluateAll((els) => els.map((el) => {
      // The live code widget (2026-11-07) names its language in its own header bar.
      const bar = el.closest('[data-code-block]')?.querySelector('[data-markdown-copy="exclude"]')
      let label = bar ? ((bar as HTMLElement).innerText ?? '').trim().split('\n')[0]!.trim() : ''
      // Otherwise the header sits before the block's `pre`, in it or in one of its wrappers.
      if (!bar) for (let node: Element | null = el.closest('pre') ?? el; node && !label && node.tagName !== 'MAIN'; node = node.parentElement) {
        const header = node.previousElementSibling
        const line = header && !header.querySelector('pre') ? (header.textContent ?? '').trim() : ''
        if (line && line.length <= 40 && !line.includes('\n')) label = line
        if (header) break
      }
      ;(el as HTMLElement).style.whiteSpace = 'pre-wrap'
      return { label, code: (el as HTMLElement).innerText.replace(/\n$/, '') }
    })).catch(() => [])
  }

}

/**
 * The fenced code blocks of Markdown by CommonMark's rule: a closing fence is the opening one's
 * character, at least as long, with nothing after it; a shorter fence, or one of the other character, inside is content. `start`
 * and `end` bound the block's lines in the text; an unclosed block is not one.
 */
function fencedBlocks(markdown: string): Array<{ start: number; end: number; info: string }> {
  const found: Array<{ start: number; end: number; info: string }> = []
  let open: { start: number; char: string; length: number; info: string } | undefined
  let at = 0
  for (const line of markdown.split('\n')) {
    const end = at + line.length
    if (!open) {
      // A backtick fence's info string holds no backtick; a tilde fence's may.
      const start = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/.exec(line)
      if (start) open = { start: at, char: start[1] ? '`' : '~', length: (start[1] ?? start[3])!.length, info: (start[2] ?? start[4])!.trim() }
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === open.char && close[1]!.length >= open.length) {
        found.push({ start: open.start, end, info: open.info })
        open = undefined
      }
    }
    at = end + 1
  }
  return found
}

/** A block written as Markdown: its fence one backtick longer than the longest run in its body (three at least). */
function fencedText(label: string, body: string): string {
  const fence = '`'.repeat(Math.max(3, 1 + Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))))
  return `${fence}${label}\n${body}\n${fence}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
