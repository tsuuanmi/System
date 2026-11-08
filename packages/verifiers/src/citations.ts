/**
 * `research.citation-check`: check a `sources` Artifact (JSON) against the
 * web as it is at verification time (ADR-0004 decision 13).
 *
 * Format: `{"sources": [{"id", "url", "quote", "claims": [..]}]}`. Each URL
 * is fetched and its text searched for the quote, ignoring markup, Markdown
 * marks, case and whitespace. Verdict: `fail` for a malformed file or too few
 * sources; `pass` when at least `minConfirmedRatio` of the sources are
 * confirmed; `inconclusive` when fewer are (the page may have changed: this
 * never proves what the Worker read). A pass can include unconfirmed quotes:
 * the reason names each with why, and the evidence lists every result with
 * the ratio and threshold used. Criteria pinned without `minConfirmedRatio`
 * mean 1.0: every quote must be found, as before version 2. Version 3:
 * `normalize` finds quotes beside links and table cells (see there).
 *
 * `citations-v2` (verifier version 4; the criteria name selects it, `v1`
 * stays as it was so earlier verdicts reproduce): the quote need only be
 * loosely there (`looseMatch`), the report's `[id]`s and the sources must
 * agree (`completeness`), and a page that cannot be read (HTTP 4xx/5xx, a
 * fetch error) counts neither way: the ratio is over the readable sources, and
 * with none readable the verdict is `inconclusive`.
 */
import { createHash } from 'node:crypto'
import type { Artifacts } from '@system/artifacts'
import type { VerifierPort, VerifyResult } from '@system/work'
import { z } from 'zod'

export const CITATION_CRITERIA_KIND = { kind: 'citation-criteria', schemaVersion: 1 } as const
export const citationCriteriaSchema = z.object({
  name: z.string(),
  minSources: z.number().int().positive(),
  minQuoteChars: z.number().int().positive(),
  fetchTimeoutMs: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  minConfirmedRatio: z.number().min(0).max(1).optional(),
  /** `citations-v2`: the share of a quote's words that must appear in order near each other; absent means the exact match of v1. */
  minWordMatch: z.number().min(0).max(1).optional(),
}).strict()
export type CitationCriteria = z.infer<typeof citationCriteriaSchema>

const DEFAULT_CRITERIA: Omit<CitationCriteria, 'name'> = { minSources: 1, minQuoteChars: 8, fetchTimeoutMs: 20_000, maxBytes: 2 * 1024 * 1024, minConfirmedRatio: 0.5 }

export const sourcesSchema = z.object({
  sources: z.array(z.object({
    id: z.string().min(1),
    url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http or https'),
    quote: z.string(),
    claims: z.array(z.string().min(1)).min(1),
  }).strict()),
}).strict()

export const CITATION_CHECK_KIND = { kind: 'citation-check', schemaVersion: 1 } as const
export const citationCheckSchema = z.object({
  problems: z.array(z.string()),
  minConfirmedRatio: z.number().optional(),
  minWordMatch: z.number().optional(),
  confirmedRatio: z.number().optional(),
  results: z.array(z.object({
    id: z.string(), url: z.string(), status: z.number().int().nullable(), found: z.boolean(),
    contentHash: z.string().optional(), error: z.string().optional(),
    /** v2 only: whether the page could be read; the share of the quote's words found (0 to 1); the nearest passage, at most 300 characters. */
    readable: z.boolean().optional(), wordRatio: z.number().optional(), passage: z.string().optional(),
  }).strict()),
}).strict()
type CheckResult = z.infer<typeof citationCheckSchema>['results'][number]

const INLINE_TAG = /<\/?(?:a|abbr|b|bdi|bdo|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)(?:\s[^>]*)?>/gi

/** Text for matching: scripts and styles removed, inline tags (`a`, `span`, `em`...) removed with nothing because they are not word boundaries, every other tag read as a space, Markdown links reduced to their text and code/emphasis marks dropped, common entities decoded, `|` read as whitespace, case and whitespace folded, and no space before `,.;:!?)`. */
export function normalize(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(INLINE_TAG, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[\s|]+/g, ' ').replace(/ ([,.;:!?)])/g, '$1').trim().toLowerCase()
}

const V2_CRITERIA: Omit<CitationCriteria, 'name'> = { ...DEFAULT_CRITERIA, minWordMatch: 0.8 }
const USER_AGENT_V2 = 'System-citation-check/1.0 (+https://github.com/tsuuanmi/System)'
const MAX_PASSAGE = 300

const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu

/**
 * How much of `quote` (normalised) is on `page` (normalised), loosely: the
 * share of the quote's words that appear in the same order within one window
 * of the page's words, a window being 1.5 x the quote's words long. Words are
 * letters and digits, so punctuation never matters. Per window start the best
 * in-order match is a longest common subsequence. The search is bounded: a
 * window starts only at a page word equal to one of the quote's first
 * `n - ceil(n x minWordMatch) + 1` words (a match reaching `minWordMatch`
 * can skip no more leading words than that), and the page is capped at
 * `maxBytes`. `passage` is the best window's text, cut to 300 characters.
 */
export function looseMatch(page: string, quote: string, minWordMatch: number): { ratio: number; passage: string } {
  const q = [...quote.matchAll(WORD)].map((m) => m[0])
  const words = [...page.matchAll(WORD)].map((m) => ({ word: m[0], start: m.index!, end: m.index! + m[0].length }))
  if (!q.length) return { ratio: 0, passage: '' }
  const size = Math.ceil(q.length * 1.5)
  const leading = new Set(q.slice(0, q.length - Math.ceil(q.length * minWordMatch) + 1))
  let best = { matched: 0, from: 0, to: 0 }
  for (let i = 0; i < words.length && best.matched < q.length; i++) {
    if (!leading.has(words[i]!.word)) continue
    const end = Math.min(words.length, i + size)
    // Longest common subsequence of the quote and words[i, end), one row at a time.
    let row = new Array<number>(end - i + 1).fill(0)
    for (const w of q) {
      const next = [0]
      for (let j = 1; j <= end - i; j++) next[j] = words[i + j - 1]!.word === w ? row[j - 1]! + 1 : Math.max(row[j]!, next[j - 1]!)
      row = next
    }
    const matched = row[end - i]!
    if (matched > best.matched) best = { matched, from: i, to: end }
  }
  if (!best.matched) return { ratio: 0, passage: '' }
  return { ratio: best.matched / q.length, passage: page.slice(words[best.from]!.start, words[best.to - 1]!.end).slice(0, MAX_PASSAGE) }
}

/** The `[id]`s a report cites: bracketed ids that are not the text of a Markdown link. */
function citedIds(report: string): Set<string> {
  return new Set([...report.matchAll(/\[([A-Za-z0-9][\w.-]*)\](?!\()/g)].map((m) => m[1]!))
}

/** What is wrong between a report and its sources, naming the ids; the sources' claims count too. */
export function completeness(report: string, sources: z.infer<typeof sourcesSchema>['sources']): string[] {
  const cited = citedIds(report)
  const known = new Set(sources.map((x) => x.id))
  const problems: string[] = []
  const unknown = [...cited].filter((id) => !known.has(id))
  if (unknown.length) problems.push(`the report cites ${unknown.map((id) => `[${id}]`).join(', ')}, not in sources`)
  const unused = sources.filter((x) => !cited.has(x.id)).map((x) => x.id)
  if (unused.length) problems.push(`sources not cited in the report: ${unused.join(', ')}`)
  const bare = sources.filter((x) => !x.claims.some((c) => c.trim())).map((x) => x.id)
  if (bare.length) problems.push(`sources without a claim: ${bare.join(', ')}`)
  return problems
}

async function fetchText(url: string, criteria: CitationCriteria): Promise<{ status: number; text: string; contentHash: string }> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(criteria.fetchTimeoutMs), headers: { 'user-agent': criteria.minWordMatch === undefined ? 'System citation check' : USER_AGENT_V2 } })
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (reader && size < criteria.maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader?.cancel().catch(() => undefined)
  const bytes = Buffer.concat(chunks).subarray(0, criteria.maxBytes)
  return { status: response.status, text: bytes.toString('utf8'), contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
}

export function citationCheck(artifacts: Artifacts): VerifierPort {
  const producer = { type: 'verifier' as const, ref: 'research.citation-check' }
  return {
    ref: 'research.citation-check',
    version: '4',
    capabilities: ['research.citation-check'],
    accepts: ['file'],
    async criteria({ name }) {
      return (await artifacts.put({ ...CITATION_CRITERIA_KIND, content: { name, ...(name === 'citations-v2' ? V2_CRITERIA : DEFAULT_CRITERIA) }, classification: 'public', producer })).id
    },
    async verify(request): Promise<VerifyResult> {
      const criteriaRead = artifacts.get(request.criteria)
      const criteria = criteriaRead.state === 'stored' ? citationCriteriaSchema.parse(criteriaRead.envelope.content) : undefined
      if (!criteria) return { verdict: 'error', reason: 'the pinned criteria are not stored', subject: request.subject, criteria: request.criteria, evidence: [] }
      const problems: string[] = []
      const results: CheckResult[] = []
      let parsed: z.infer<typeof sourcesSchema> | undefined
      try {
        const checked = sourcesSchema.safeParse(JSON.parse(Buffer.from(await artifacts.readBytes(request.subject)).toString('utf8')))
        if (checked.success) parsed = checked.data
        else problems.push(...checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
      } catch (error) {
        problems.push(`not JSON: ${(error as Error).message}`)
      }
      if (parsed) {
        if (parsed.sources.length < criteria.minSources) problems.push(`${parsed.sources.length} source(s); at least ${criteria.minSources} required`)
        for (const source of parsed.sources) if (normalize(source.quote).length < criteria.minQuoteChars) problems.push(`source ${source.id}: the quote is shorter than ${criteria.minQuoteChars} characters`)
      }
      const loose = criteria.minWordMatch
      const reportId = request.inputs?.report
      if (parsed && loose !== undefined && reportId) {
        const read = await artifacts.readBytes(reportId).then((b) => Buffer.from(b).toString('utf8'), (error: Error) => { problems.push(`the report cannot be read: ${error.message}`); return undefined })
        if (read !== undefined) problems.push(...completeness(read, parsed.sources))
      }
      if (parsed && !problems.length) {
        for (const source of parsed.sources) {
          try {
            const page = await fetchText(source.url, criteria)
            const readable = page.status < 400
            if (loose === undefined) {
              results.push({ id: source.id, url: source.url, status: page.status, found: readable && normalize(page.text).includes(normalize(source.quote)), contentHash: page.contentHash })
            } else {
              const near = readable ? looseMatch(normalize(page.text), normalize(source.quote), loose) : { ratio: 0, passage: '' }
              results.push({ id: source.id, url: source.url, status: page.status, found: readable && near.ratio >= loose, contentHash: page.contentHash, readable, ...(readable ? { wordRatio: near.ratio, passage: near.passage } : {}) })
            }
          } catch (error) {
            results.push({ id: source.id, url: source.url, status: null, found: false, error: `fetch failed: ${(error as Error).message}`, ...(loose === undefined ? {} : { readable: false }) })
          }
        }
      }
      const minConfirmedRatio = criteria.minConfirmedRatio ?? 1
      // v2 judges the readable sources only; v1 counted every source.
      const counted = loose === undefined ? results : results.filter((r) => r.readable)
      const confirmed = counted.filter((r) => r.found).length
      const confirmedRatio = counted.length ? confirmed / counted.length : undefined
      const evidence = (await artifacts.put({
        ...CITATION_CHECK_KIND, content: { problems, minConfirmedRatio, ...(loose === undefined ? {} : { minWordMatch: loose }), confirmedRatio, results }, inputs: [request.subject, request.criteria, ...Object.values(request.inputs ?? {})],
        classification: 'local-private', producer,
      })).id
      const result = (verdict: VerifyResult['verdict'], reason: string): VerifyResult => ({ verdict, reason, subject: request.subject, criteria: request.criteria, evidence: [evidence] })
      if (problems.length) return result('fail', `the sources file is not acceptable: ${problems.join('; ')}`)
      if (loose !== undefined) {
        const percent = (r: CheckResult) => `${Math.round((r.wordRatio ?? 0) * 100)}%`
        const unreadable = results.filter((r) => !r.readable).map((r) => `${r.id} (${r.error ?? `HTTP ${r.status}`})`)
        const wrong = counted.filter((r) => !r.found).map((r) => `${r.id} (HTTP ${r.status}, ${percent(r)} of the quote's words, needs ${loose * 100}%)`)
        const note = [wrong.length ? `not confirmed: ${wrong.join(', ')}` : '', unreadable.length ? `unreadable, not counted: ${unreadable.join(', ')}` : ''].filter(Boolean).join('; ')
        const tally2 = `${confirmed} of ${counted.length} readable confirmed (needs ${minConfirmedRatio})`
        if (confirmedRatio === undefined) return result('inconclusive', `no source could be read: ${unreadable.join(', ')}`)
        if (confirmedRatio < minConfirmedRatio) return result('inconclusive', `${tally2}; ${note}`)
        return result('pass', note ? `${tally2}; ${note}` : `all ${counted.length} quote(s) found at their URLs`)
      }
      const unconfirmed = results.filter((r) => !r.found)
      const why = unconfirmed.map((r) => `${r.id} (${r.error ?? `HTTP ${r.status}, quote ${r.status !== null && r.status < 400 ? 'not found' : 'unreadable'}`})`).join(', ')
      const tally = `${confirmed} of ${results.length} confirmed (needs ${minConfirmedRatio})`
      if (confirmedRatio !== undefined && confirmedRatio < minConfirmedRatio) return result('inconclusive', `${tally}; not confirmed now: ${why}`)
      return result('pass', unconfirmed.length ? `${tally}; accepted with unconfirmed: ${why}` : `all ${results.length} quote(s) found at their URLs`)
    },
  }
}
