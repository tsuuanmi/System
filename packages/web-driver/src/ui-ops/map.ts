// Ported from System 1 (tsuuanmi/system @ f199a277): packages/ui-ops/src/map.ts. Changes: packages/web-driver/README.md.
/**
 * Load a provider's UI map (`ui-map@1.0`, schemas/ui-map.v1.json) and merge the local
 * overlay. Overlay candidates come after the shipped ones and are tagged, so the
 * shipped map always wins when it still works (docs/design/ui-operations.md).
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type ContentId, contentId } from '../core/canonical.ts'
import { ensurePrivateDir, writeFileDurable } from '../core/files.ts'
import { parse, parseDocument } from 'yaml'

export type Localized = Record<string, string>

export type Candidate =
  | { testId: string }
  | { role: string; name?: Localized; exact?: boolean }
  | { label: Localized }
  | { text: Localized }
  | { css: string }

export type SourcedCandidate = Candidate & { source: 'shipped' | 'overlay' }

export type Condition =
  | { visible: string } | { hidden: string } | { countIncreased: string }
  | { attr: { of: string; name: string; equals?: string; present?: boolean } }
  | { url: string } | { network: string } | { state: string }
  | { stableTextMs: number; of: string }
  | { anyOf: Condition[] } | { allOf: Condition[] } | { not: Condition }

export interface Fingerprint {
  role?: string
  name?: Localized
  nearRole?: string
}

export interface ElementSpec {
  description?: string
  /** `any` searches every frame (a report rendered in an iframe); such elements take no scope. */
  frames?: 'main' | 'any'
  /** Not yet checked on the live site (`ui-map@1.2`): no irreversible action may depend on it. */
  unverified?: true
  scope?: string
  cardinality?: 'one' | 'many'
  candidates: SourcedCandidate[]
  fingerprint?: Fingerprint
}

export type SideEffect = 'none' | 'reversible' | 'irreversible'

export interface ActionSpec {
  description?: string
  do: 'click' | 'insertText' | 'pasteText' | 'attachText' | 'clearText' | 'press' | 'setFiles' | 'select'
  target: string
  key?: string
  require?: Array<'enabled' | 'editable'>
  fallback?: { press: string; on: string }
  verify: Condition
  sideEffect: SideEffect
  heal?: 'off' | 'deterministic' | 'model'
  timeouts?: { resolveMs?: number; verifyMs?: number }
  /** Not yet checked on the live site (`ui-map@1.2`). */
  unverified?: true
}

export interface NetworkPattern {
  url: string
  method?: string
  status?: number
  contentType?: string
  open?: boolean
  header?: { name: string; equals?: string }
}

export interface ErrorRule {
  when: Condition
  kind: 'challenge' | 'reauth_required' | 'quota_exhausted' | 'invalid_input' | 'provider_stalled' | 'network' | 'session_broken'
  message?: string
  /** The account feature a `quota_exhausted` rule's limit applies to (`ui-map@1.4`, ADR-0034); none means the whole account. */
  feature?: string
  /**
   * When the rule is checked (`ui-map@1.4`): before every action (`act`, the default), or on a turn's
   * answer once it is read (`answer`: the site answered with its limit, so the turn was sent).
   */
  on?: 'act' | 'answer'
}

/** The site's own clocks (`ui-map@1.5`), milliseconds; a map without `settings` gets the defaults. */
export interface UiSettings {
  /** How long the mode switch may take to render before the mode counts as unknown. */
  modeReadyMs: number
  /** How long the mode the switch shows must hold before it is trusted. */
  modeSettleMs: number
  /** A prompt's inputs shorter than this stay in its one part (`ui-map@1.6`): no attachment is made of a short text. */
  attachMinChars: number
  /** How long a pasted body may take to settle, as text in the composer or as one finished chip. */
  attachWaitMs: number
  /** How many of the body's first characters (whitespace collapsed) a chip's label must start with. */
  attachLabelChars: number
}
export const DEFAULT_SETTINGS: UiSettings = { modeReadyMs: 15_000, modeSettleMs: 600, attachMinChars: 4000, attachWaitMs: 30_000, attachLabelChars: 24 }

/** How an answer's outputs are read (`ui-map@1.7`); a map without `answer` lists nothing. */
export interface UiAnswer {
  /** Literal strings the site leaks into its visible text: removed where they sit at the very start or end of an output. */
  leakedTokens: string[]
}
export const DEFAULT_ANSWER: UiAnswer = { leakedTokens: [] }

export interface UiMap {
  schema: 'ui-map@1.0' | 'ui-map@1.1' | 'ui-map@1.2' | 'ui-map@1.3' | 'ui-map@1.4' | 'ui-map@1.5' | 'ui-map@1.6' | 'ui-map@1.7'
  provider: string
  uiRevision: string
  locales: string[]
  settings: UiSettings
  answer: UiAnswer
  elements: Record<string, ElementSpec>
  actions: Record<string, ActionSpec>
  network: Record<string, NetworkPattern>
  states: Record<string, Condition>
  errors: ErrorRule[]
  /** Content address of the merged map, recorded with heals and diagnostics. */
  hash: ContentId
}

/**
 * Which of `ids` (elements or actions) are not yet checked on the live site; one the map does not
 * define counts as unchecked, so a flow that depends on it fails closed.
 */
export function unverifiedEntries(map: Pick<UiMap, 'elements' | 'actions'>, ids: readonly string[]): string[] {
  return ids.filter((id) => (map.elements[id] ?? map.actions[id])?.unverified !== undefined || !(map.elements[id] ?? map.actions[id])).sort()
}

let validator: ValidateFunction | undefined

/**
 * Check a map against `ui/ui-map.v1.json`. System 1 asked its schema registry for
 * `ui-map@1.0` (all of Ajv, with its `format` checks); here only this one schema is compiled,
 * without format checks (`uiRevision` is not checked to be a date).
 */
function assertMap(value: unknown): void {
  if (!validator) {
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false })
    validator = ajv.compile(JSON.parse(readFileSync(new URL('../../ui/ui-map.v1.json', import.meta.url), 'utf8')) as object)
  }
  if (!validator(value)) throw new Error(`ui-map@1.0: ${new Ajv2020().errorsText(validator.errors)}`)
}

function references(map: Omit<UiMap, 'hash'>): string[] {
  const missing: string[] = []
  const element = (id: string, where: string): void => {
    if (!map.elements[id]) missing.push(`${where}: unknown element ${id}`)
  }
  const walk = (c: Condition, where: string): void => {
    if ('visible' in c) element(c.visible, where)
    else if ('hidden' in c) element(c.hidden, where)
    else if ('countIncreased' in c) element(c.countIncreased, where)
    else if ('attr' in c) element(c.attr.of, where)
    else if ('stableTextMs' in c) element(c.of, where)
    else if ('network' in c) { if (!map.network[c.network]) missing.push(`${where}: unknown network signal ${c.network}`) }
    else if ('state' in c) { if (!map.states[c.state]) missing.push(`${where}: unknown state ${c.state}`) }
    else if ('anyOf' in c) c.anyOf.forEach((x) => walk(x, where))
    else if ('allOf' in c) c.allOf.forEach((x) => walk(x, where))
    else if ('not' in c) walk(c.not, where)
  }
  for (const [id, e] of Object.entries(map.elements)) if (e.scope) element(e.scope, `elements.${id}.scope`)
  for (const [id, a] of Object.entries(map.actions)) {
    element(a.target, `actions.${id}.target`)
    if (a.fallback) element(a.fallback.on, `actions.${id}.fallback`)
    walk(a.verify, `actions.${id}.verify`)
  }
  for (const [id, s] of Object.entries(map.states)) walk(s, `states.${id}`)
  map.errors.forEach((e, i) => walk(e.when, `errors[${i}]`))
  return missing
}

/**
 * Parse and validate a shipped map (YAML or JSON text), then merge the overlay: candidates for
 * elements the map defines, after the shipped ones; elements it does not define; and error rules,
 * after the shipped ones (a site's usage-limit text, without a release; ADR-0034). The merged map
 * is validated again.
 */
export function loadUiMap(text: string, overlayText?: string): UiMap {
  const raw = parse(text) as Record<string, unknown>
  assertMap(raw)
  const shipped = raw as unknown as Omit<UiMap, 'hash' | 'settings' | 'answer' | 'actions' | 'network' | 'states' | 'errors'> & Partial<UiMap>
  const elements: Record<string, ElementSpec> = {}
  let overlayErrors: ErrorRule[] = []
  for (const [id, e] of Object.entries(shipped.elements)) {
    elements[id] = { ...e, candidates: e.candidates.map((c) => ({ ...c, source: 'shipped' as const })) }
  }
  if (overlayText) {
    const overlay = (parse(overlayText) ?? {}) as { elements?: Record<string, Omit<ElementSpec, 'candidates'> & { candidates?: Candidate[] }>; errors?: ErrorRule[] }
    for (const [id, e] of Object.entries(overlay.elements ?? {})) {
      const target = elements[id]
      if (target) for (const c of e.candidates ?? []) target.candidates.push({ ...c, source: 'overlay' })
      else elements[id] = { ...e, candidates: (e.candidates ?? []).map((c) => ({ ...c, source: 'overlay' as const })) }
    }
    overlayErrors = overlay.errors ?? []
  }
  const map = {
    schema: shipped.schema,
    provider: shipped.provider,
    uiRevision: shipped.uiRevision,
    locales: shipped.locales,
    settings: { ...DEFAULT_SETTINGS, ...shipped.settings },
    answer: { ...DEFAULT_ANSWER, ...shipped.answer },
    elements,
    actions: shipped.actions ?? {},
    network: shipped.network ?? {},
    states: shipped.states ?? {},
    errors: [...(shipped.errors ?? []), ...overlayErrors],
  }
  const missing = references(map)
  if (missing.length) throw new Error(`UI map ${map.provider} has dangling references: ${missing.join('; ')}`)
  if (overlayText) assertMap({ ...raw, elements: stripSources(elements), errors: map.errors })
  return { ...map, hash: contentId(map) }
}

function stripSources(elements: Record<string, ElementSpec>): Record<string, unknown> {
  const plain = (c: SourcedCandidate): Candidate => {
    const copy: Partial<SourcedCandidate> = { ...c }
    delete copy.source
    return copy as Candidate
  }
  return Object.fromEntries(Object.entries(elements).map(([id, e]) => [id, { ...e, candidates: e.candidates.map(plain) }]))
}

/**
 * Append a verified healed candidate to a local overlay file (owner-only, durable). A
 * candidate already present is not added twice. The shipped map is never modified; the
 * comment names the decision so the change can be reviewed and promoted.
 */
export function appendOverlay(path: string, element: string, candidate: Candidate, note: string): boolean {
  ensurePrivateDir(dirname(path))
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : 'elements: {}\n')
  const list = (doc.getIn(['elements', element, 'candidates']) as { toJSON(): unknown } | undefined)?.toJSON() as Candidate[] | undefined
  if (list?.some((c) => JSON.stringify(c) === JSON.stringify(candidate))) return false
  if (!list) doc.setIn(['elements', element, 'candidates'], doc.createNode([]))
  const node = doc.createNode(candidate)
  node.commentBefore = ` ${note}`
  doc.addIn(['elements', element, 'candidates'], node)
  writeFileDurable(path, doc.toString(), 0o600)
  return true
}
