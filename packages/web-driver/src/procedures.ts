/**
 * The generic Procedures of a website Worker (PLAN WW step 2): fixed control flow over the UI engine,
 * bound to one Site by its map (`ui-map@1.7`: `site`, `modes`, `answer`, `settings`, with the states
 * `auth.*` and `site.error-page` and the actions `composer.clear/insert/attach/send` named by
 * convention). No Site is named here; a Site is a map and a page.
 *
 * Each Procedure returns a typed result and throws only for a caller's abort: `ok`; `failed`, the
 * page positively showed why (or nothing was done); `unknown`, what happened is not known, so the
 * caller must not assume either way. Evidence is counts and names, never page or prompt text.
 * Nothing is retried here: a prompt that may have been sent (`send` unknown) is never sent again,
 * and a site error is classified (`retryable`), never worked around.
 */
import type { Locator, Page } from 'patchright-core'
import { ProviderError, sleep } from './core/index.ts'
import { type EngineOptions, linksIn, preWrapText, type UiMap, UiEngine } from './ui-ops/index.ts'

export type Status = 'ok' | 'failed' | 'unknown'

export interface Result<T = undefined> {
  status: Status
  reason?: string
  evidence: Record<string, unknown>
  value?: T
}

/** The counts before a send; an answer is only the one after them. */
export interface Baseline {
  turns: number
  userTurns: number
}

export interface Block {
  /** The block's label as the page shows it (its first line, trimmed); `''` when the map has no label element. */
  label: string
  /** The code as rendered, rows kept; one trailing line break removed. */
  code: string
}

export interface AnswerRead {
  text: string
  blocks: Block[]
  links: Array<{ href: string; text: string }>
}

export interface ProcedureOptions {
  /** The Site's origin when it is not the map's (a test's local one). */
  origin?: string
  /** How long the first page state may take to show (default 30 s). */
  readyMs?: number
  engine?: EngineOptions
}

export interface WaitOptions {
  /** Defaults are the map's `settings`. */
  timeoutMs?: number
  stableMs?: number
  pollMs?: number
  signal?: AbortSignal
}

const done = <T>(evidence: Record<string, unknown>, value?: T): Result<T> => ({ status: 'ok', evidence, ...(value !== undefined ? { value } : {}) })
const failed = <T = undefined>(reason: string, evidence: Record<string, unknown> = {}): Result<T> => ({ status: 'failed', reason, evidence })
const unknown = <T = undefined>(reason: string, evidence: Record<string, unknown> = {}): Result<T> => ({ status: 'unknown', reason, evidence })

/** An engine failure the page explains: kept as a result with its kind; anything else is the caller's (an abort, a bug). */
async function expected<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ProviderError && error.kind !== 'aborted') return failed(error.message, { error: error.kind })
    throw error
  }
}

/** Kinds the engine raises before it acts (a guard), so nothing was sent. */
const GUARD_KINDS = new Set(['challenge', 'reauth_required', 'invalid_input', 'quota_exhausted'])

const AUTH = ['auth.signed-in', 'auth.signed-out', 'auth.login-page', 'auth.challenge', 'site.error-page'] as const
const ACTIONS = ['composer.clear', 'composer.insert', 'composer.send'] as const

/** What a map still lacks for the Procedures; checked before any browser opens. */
export function bindingProblems(map: UiMap): string[] {
  const problems: string[] = []
  if (!map.site) problems.push('site: missing (origin)')
  if (!map.states['auth.signed-in']) problems.push('states: auth.signed-in is missing')
  for (const id of ACTIONS) if (!map.actions[id]) problems.push(`actions: ${id} is missing`)
  if (!map.answer.turn) problems.push('answer.turn: missing')
  if (!map.answer.userTurn) problems.push('answer.userTurn: missing')
  if (map.answer.codeLabel && !map.answer.code) problems.push('answer.codeLabel: needs answer.code')
  return problems
}

export class Procedures {
  readonly engine: UiEngine
  private readonly page: Page
  private readonly map: UiMap
  private readonly options: ProcedureOptions

  constructor(page: Page, map: UiMap, options: ProcedureOptions = {}) {
    const problems = bindingProblems(map)
    if (problems.length) throw new ProviderError('config_error', `${map.provider}: the map does not bind the Procedures: ${problems.join('; ')}`)
    this.page = page
    this.map = map
    this.options = options
    this.engine = new UiEngine(page, map, options.engine)
  }

  dispose(): void {
    this.engine.dispose()
  }

  private get origin(): string {
    return this.options.origin ?? this.map.site!.origin
  }

  /** Signed in (the composer shows), or why not: signed out (positive evidence only), a challenge, the site's error page, or unknown. */
  checkAuth(): Promise<Result> {
    return expected(async () => {
      const { engine, map } = this
      if (!this.page.url().startsWith(this.origin)) await this.page.goto(`${this.origin}/`, { waitUntil: 'domcontentloaded' })
      const known = AUTH.filter((id) => map.states[id])
      const seen = (): Promise<string | undefined> => (async () => {
        for (const id of known) if (id !== 'auth.login-page' && (await engine.state(id))) return id
        return undefined
      })()
      const deadline = Date.now() + (this.options.readyMs ?? 30_000)
      let first = await seen()
      while (!first && Date.now() < deadline) {
        await sleep(100)
        first = await seen()
      }
      if (!first) return unknown('the page showed neither the app nor a sign-in page in time', { auth: 'unknown' })
      // A challenge or an error page is neither: only the operator, or a later try, can help.
      if (first === 'auth.challenge') return failed('the site shows a challenge', { auth: 'challenge' })
      if (first === 'site.error-page') return failed("the site's own error page shows in place of the app", { auth: 'error-page', retryable: true })
      if (first === 'auth.signed-in' && !(await engine.state('auth.signed-out'))) return done({ auth: 'signed-in' })
      if (await engine.state('auth.login-page')) return failed('signed out', { auth: 'signed-out' })
      // Only a logged-out home: the app may paint that shell before its session loads, and a false sign-out costs the operator a re-login.
      const held = await engine.waitFor({ state: 'auth.signed-in' }, map.settings.signedOutHoldMs).then(() => true, () => false)
      if (held) return done({ auth: 'signed-in', held: true })
      if (await engine.state('auth.signed-out')) return failed('signed out', { auth: 'signed-out' })
      return unknown('the page showed neither the app nor a sign-in page in time', { auth: 'unknown' })
    })
  }

  /**
   * A new chat on the Site's home; a page already showing an empty new chat is kept as it is, so the mode chosen on it stays
   * (the Site may restore another one on a load). `temporary`: `required` fails when the Site has none or it cannot be entered
   * (never a silent downgrade); `preferred` goes on in a normal chat and says so in the evidence.
   */
  openChat(options: { temporary?: 'required' | 'preferred' } = {}): Promise<Result> {
    return expected(async () => {
      if (!(await this.newChat())) await this.page.goto(`${this.origin}/`, { waitUntil: 'domcontentloaded' })
      const wanted = options.temporary
      if (!wanted) return done({ temporary: false })
      const entry = this.map.site!.temporaryChat
      const refuse = (why: string): Result => (wanted === 'required' ? failed(`a temporary chat is required: ${why}`, { temporary: false, required: true }) : done({ temporary: false, downgraded: why }))
      if (!entry) return refuse('the site has none')
      try {
        await this.engine.act(entry.action)
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        return refuse(error.message)
      }
      return done({ temporary: true })
    })
  }

  /** The page is the Site's home with no turn on it. */
  private async newChat(): Promise<boolean> {
    try {
      const url = new URL(this.page.url())
      return url.origin === new URL(this.origin).origin && url.pathname === '/' && (await this.engine.count(this.map.answer.turn!)) === 0 && (await this.engine.count(this.map.answer.userTurn!)) === 0
    } catch {
      return false
    }
  }

  /**
   * The required mode, verified by its own state (never by the absence of another), held for `modeSettleMs`. A site
   * without `modes` has none to verify. A forbidden mode is left by the map's `select` action once, else fails; a mode
   * that cannot be read, or a switch that never shows, is `unknown`.
   */
  ensureMode(): Promise<Result> {
    return expected(async () => {
      const { engine, map } = this
      const modes = map.modes
      if (!modes) return done({ modes: 'none' })
      const { modeReadyMs, modeSettleMs } = map.settings
      const deadline = Date.now() + modeReadyMs
      let selected = false
      let shown = false
      let since: number | undefined
      for (;;) {
        const now = await this.modeNow()
        shown ||= (await engine.count(modes.switch)) > 0
        if (now.forbidden) {
          if (selected || !modes.select) return failed(`a forbidden mode holds (${now.forbidden})`, { mode: 'forbidden', state: now.forbidden, selected })
          await engine.act(modes.select).catch((error: unknown) => {
            if (!(error instanceof ProviderError)) throw error
          })
          selected = true
          since = undefined
          continue
        }
        if (now.required) {
          since ??= Date.now()
          if (Date.now() - since >= modeSettleMs) return done({ mode: 'required', selected })
        } else {
          since = undefined
          // The switch is there but shows neither the required nor a forbidden mode: select it, once.
          if (!selected && modes.select && (await engine.count(modes.switch)) > 0) {
            selected = true
            await engine.act(modes.select).catch((error: unknown) => {
              if (!(error instanceof ProviderError)) throw error
            })
            continue
          }
        }
        // The deadline bounds finding the mode; a mode already seen may finish its hold (selecting it can take most of the wait).
        if (Date.now() >= deadline && since === undefined) break
        await sleep(100)
      }
      return unknown(shown ? 'the mode could not be read as the required one' : 'the mode switch never showed: the mode is unverified', { mode: 'unverified', switchShown: shown })
    })
  }

  /** The mode now: the first forbidden state that holds, and whether the required one does. */
  private async modeNow(): Promise<{ forbidden?: string; required: boolean }> {
    const modes = this.map.modes!
    for (const id of modes.forbidden ?? []) if (await this.engine.state(id)) return { forbidden: id, required: false }
    return { required: await this.engine.state(modes.required) }
  }

  /**
   * The model and Power the Site shows, read and never set (WW8a). Bound by the map's `model.open` and `model.close` actions
   * and its `model.power-status` (text beginning with the level) and `model.selected` (the checked model) elements; a Site
   * without them has none to read, and both values are null. A menu already open is read as it is. The menu is closed
   * again by `model.close` when it shows, which verifies it gone: a menu that stays open is `failed`, with whatever was read kept in the
   * value. A value that cannot be read is null.
   */
  observeModel(): Promise<Result<{ model: string | null; power: string | null }>> {
    return expected(async () => {
      const { engine, map } = this
      const seen: { model: string | null; power: string | null } = { model: null, power: null }
      if (!map.actions['model.open'] || !map.actions['model.close'] || !map.elements['model.menu']) return done({ observed: false }, seen)
      const level = async (id: string): Promise<string | null> => {
        if (!map.elements[id]) return null
        // The first line, and the first clause of it ("<level>, <n> of <total>."): names, never the page's text around them.
        const text = await engine.text(id).catch(() => '')
        return text.split('\n')[0]!.split(',')[0]!.trim() || null
      }
      try {
        if ((await engine.count('model.menu')) === 0) await engine.act('model.open')
        seen.power = await level('model.power-status')
        if (map.elements['model.selected'] && map.actions['model.show-models']) {
          await engine.act('model.show-models')
          seen.model = await level('model.selected')
        }
      } catch (error) {
        if (!(error instanceof ProviderError) || error.kind === 'aborted') throw error
      }
      try {
        if ((await engine.count('model.menu')) > 0) await engine.act('model.close')
      } catch (error) {
        if (!(error instanceof ProviderError) || error.kind === 'aborted') throw error
        return { ...failed<typeof seen>(`the model menu did not close: ${error.message}`, { observed: true }), value: seen }
      }
      return done({ observed: true, model: seen.model !== null, power: seen.power !== null }, seen)
    })
  }

  /** Empty the composer, then insert the instructions; the engine reads the text back and fails when it differs. */
  insertInstructions(text: string): Promise<Result> {
    return expected(async () => {
      await this.engine.act('composer.clear')
      await this.engine.act('composer.insert', { text })
      return done({ chars: text.length })
    })
  }

  /**
   * The prompt's body, pasted after the header already in the composer, accepted as the text in the composer or as
   * one new attachment, whichever the page shows; the action `composer.attach` says the Site takes it at all.
   */
  attachText(body: string, header: string): Promise<Result<{ outcome: 'text' | 'attachment' }>> {
    return expected(async () => {
      if (!this.map.actions['composer.attach']) return failed('the map declares no way to attach text', { attached: false })
      const { outcome, chips } = await this.engine.attachText('composer.attach', body, header, this.map.settings.attachWaitMs)
      return done({ outcome, chips, chars: body.length }, { outcome })
    })
  }

  /** How many turns the page shows now: the baseline an answer is read after. */
  async baseline(): Promise<Baseline> {
    const { turn, userTurn } = this.map.answer
    return { turns: await this.engine.count(turn!), userTurns: await this.engine.count(userTurn!) }
  }

  /**
   * Send what the composer holds. `accepted`: the page shows a new user turn. `rejected`: nothing was sent (a forbidden or
   * unverified mode, no send control, a guard of the map). `unknown`: it may have been sent and nothing shows it; the caller
   * must not send it again. The baseline of the answer is taken here, before the click.
   */
  send(): Promise<Result<Baseline>> {
    return expected(async () => {
      const { engine, map } = this
      if (map.modes) {
        const now = await this.modeNow()
        if (now.forbidden) return failed(`rejected before sending: a forbidden mode holds (${now.forbidden})`, { outcome: 'rejected', mode: 'forbidden' })
        if (!now.required) return failed('rejected before sending: the required mode is not verified', { outcome: 'rejected', mode: 'unverified' })
      }
      const spec = map.actions['composer.send']!
      if (!spec.fallback && (await engine.count(spec.target)) === 0) return failed('rejected before sending: the send control is not on the page', { outcome: 'rejected' })
      const baseline = await this.baseline()
      let thrown: unknown
      try {
        await engine.act('composer.send')
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        thrown = error
      }
      const acknowledged = async (): Promise<boolean> => (await engine.count(map.answer.userTurn!).catch(() => 0)) > baseline.userTurns
      const until = Date.now() + map.settings.sendAckMs
      for (;;) {
        if (await acknowledged()) return done({ outcome: 'accepted', userTurns: baseline.userTurns + 1 }, baseline)
        // A guard of the map fires before the click: nothing was sent.
        if (thrown instanceof ProviderError && GUARD_KINDS.has(thrown.kind)) return failed(`rejected before sending: ${thrown.message}`, { outcome: 'rejected', error: thrown.kind })
        if (Date.now() >= until) break
        await sleep(100)
      }
      return { status: 'unknown', reason: `the prompt may have been sent: no new user turn within ${map.settings.sendAckMs} ms`, evidence: { outcome: 'unknown', ...(thrown instanceof ProviderError ? { error: thrown.kind } : {}) }, value: baseline }
    })
  }

  /**
   * The newest answer, once it is new (after the baseline) and finished. Each poll, in this order: the site's own error in the
   * answer (`failed`, retryable: never read as an answer), a challenge or error page, a running marker (not finished), the done
   * marker when the map has one, then the text holding for `answerStableMs`. The deadline is `unknown`: it may still come.
   */
  waitForAnswer(baseline: Baseline, options: WaitOptions = {}): Promise<Result<{ text: string }>> {
    return expected(async () => {
      const { engine, map } = this
      const { answer, settings } = map
      const timeoutMs = options.timeoutMs ?? settings.answerTimeoutMs
      const stableMs = options.stableMs ?? settings.answerStableMs
      const pollMs = options.pollMs ?? settings.answerPollMs
      const deadline = Date.now() + timeoutMs
      let candidate: string | undefined
      let since = 0
      let phase = 'no new turn'
      let turns = baseline.turns
      for (;;) {
        options.signal?.throwIfAborted()
        turns = await engine.count(answer.turn!)
        const container = turns > baseline.turns ? await this.container() : undefined
        if (container && answer.error && (await engine.stateIn(answer.error, container))) {
          return failed('site error: the answer did not load', { kind: 'site-error', retryable: true, turns })
        }
        if (map.states['auth.challenge'] && (await engine.state('auth.challenge'))) return failed('the site shows a challenge', { kind: 'challenge', turns })
        if (map.states['site.error-page'] && (await engine.state('site.error-page'))) return failed("the site's own error page shows", { kind: 'error-page', retryable: true, turns })
        const text = container ? await this.textOf(container) : ''
        if (!container || !text) {
          candidate = undefined
          phase = container ? 'empty answer' : 'no new turn'
        } else if (answer.running && (await engine.state(answer.running))) {
          candidate = undefined
          phase = 'running'
        } else if (answer.done && !(await engine.state(answer.done))) {
          candidate = undefined
          phase = 'not marked done'
        } else if (text !== candidate) {
          candidate = text
          since = Date.now()
          phase = 'text changing'
        } else if (Date.now() - since >= stableMs) {
          return done({ turns, chars: text.length, marker: answer.done ? 'done' : 'stable text' }, { text })
        }
        if (Date.now() >= deadline) break
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), options.signal)
      }
      return unknown(`no finished answer within ${timeoutMs} ms`, { phase, turns, retryable: false })
    })
  }

  /** The newest answer as the page renders it: its text, its code blocks with their labels verbatim, and its outside links. */
  readAnswer(baseline: Baseline): Promise<Result<AnswerRead>> {
    return expected(async () => {
      const { engine, map } = this
      const { answer } = map
      const turns = await engine.count(answer.turn!)
      if (turns <= baseline.turns) return failed('there is no answer after the baseline', { turns, baseline: baseline.turns })
      const container = (await this.container())!
      if (answer.error && (await engine.stateIn(answer.error, container))) return failed('site error: the answer did not load', { kind: 'site-error', retryable: true, turns })
      const text = await this.textOf(container)
      const { blocks, labels } = await this.blocksOf(container)
      const links = [...(await linksIn(container))].map(([href, label]) => ({ href, text: label }))
      return done({ turns, chars: text.length, blocks: blocks.length, links: links.length, ...(labels === undefined ? {} : { labels }) }, { text, blocks, links })
    })
  }

  /** The newest turn's answer element: the matched turn, or its parent when the map says so. */
  private async container(): Promise<Locator | undefined> {
    const { answer } = this.map
    const found = await this.engine.resolve(answer.turn!, 1000).catch(() => undefined)
    if (!found) return undefined
    const last = found.locator.last()
    return answer.container === 'parent' ? last.locator('xpath=..') : last
  }

  /** The answer's text with rows kept, without the site's prefix. */
  private async textOf(container: Locator): Promise<string> {
    const { prefix } = this.map.answer
    const text = await preWrapText(container)
    return (prefix ? text.replace(new RegExp(prefix, 'i'), '') : text).trim()
  }

  /**
   * The answer's code blocks. Labels pair with blocks by order; when their numbers differ (a snippet with no header among
   * labelled ones) no label can be trusted, so every label is `''` and `labels` says how many the page showed: a block
   * never fills an output by a name it was not shown with.
   */
  private async blocksOf(container: Locator): Promise<{ blocks: Block[]; labels?: number }> {
    const { code, codeLabel } = this.map.answer
    if (!code) return { blocks: [] }
    const codes = await this.engine.findIn(code, container).catch(() => undefined)
    const texts = codes ? await codes.locator.evaluateAll((els) => els.map((el) => {
      ;(el as HTMLElement).style.whiteSpace = 'pre-wrap'
      return (el as HTMLElement).innerText.replace(/\n$/, '')
    })).catch(() => [] as string[]) : []
    if (!codeLabel) return { blocks: texts.map((text) => ({ label: '', code: text })) }
    const found = await this.engine.findIn(codeLabel, container).catch(() => undefined)
    const labels = found ? await found.locator.evaluateAll((els) => els.map((el) => ((el as HTMLElement).innerText ?? '').trim().split('\n')[0]!.trim())).catch(() => [] as string[]) : []
    if (labels.length !== texts.length) return { blocks: texts.map((text) => ({ label: '', code: text })), labels: labels.length }
    return { blocks: texts.map((text, index) => ({ label: labels[index]!, code: text })) }
  }
}
