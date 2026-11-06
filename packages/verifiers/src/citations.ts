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
 * mean 1.0: every quote must be found, as before version 2.
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
  confirmedRatio: z.number().optional(),
  results: z.array(z.object({
    id: z.string(), url: z.string(), status: z.number().int().nullable(), found: z.boolean(),
    contentHash: z.string().optional(), error: z.string().optional(),
  }).strict()),
}).strict()
type CheckResult = z.infer<typeof citationCheckSchema>['results'][number]

/** Text for matching: tags, scripts and styles removed, Markdown links reduced to their text and code/emphasis marks dropped, common entities decoded, case and whitespace folded. */
export function normalize(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ').trim().toLowerCase()
}

async function fetchText(url: string, criteria: CitationCriteria): Promise<{ status: number; text: string; contentHash: string }> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(criteria.fetchTimeoutMs), headers: { 'user-agent': 'System citation check' } })
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
    version: '2',
    capabilities: ['research.citation-check'],
    accepts: ['file'],
    async criteria({ name }) {
      return (await artifacts.put({ ...CITATION_CRITERIA_KIND, content: { name, ...DEFAULT_CRITERIA }, classification: 'public', producer })).id
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
      if (parsed && !problems.length) {
        for (const source of parsed.sources) {
          try {
            const page = await fetchText(source.url, criteria)
            const found = page.status < 400 && normalize(page.text).includes(normalize(source.quote))
            results.push({ id: source.id, url: source.url, status: page.status, found, contentHash: page.contentHash })
          } catch (error) {
            results.push({ id: source.id, url: source.url, status: null, found: false, error: `fetch failed: ${(error as Error).message}` })
          }
        }
      }
      const minConfirmedRatio = criteria.minConfirmedRatio ?? 1
      const confirmed = results.filter((r) => r.found).length
      const confirmedRatio = results.length ? confirmed / results.length : undefined
      const evidence = (await artifacts.put({
        ...CITATION_CHECK_KIND, content: { problems, minConfirmedRatio, confirmedRatio, results }, inputs: [request.subject, request.criteria],
        classification: 'local-private', producer,
      })).id
      const result = (verdict: VerifyResult['verdict'], reason: string): VerifyResult => ({ verdict, reason, subject: request.subject, criteria: request.criteria, evidence: [evidence] })
      if (problems.length) return result('fail', `the sources file is not acceptable: ${problems.join('; ')}`)
      const unconfirmed = results.filter((r) => !r.found)
      const why = unconfirmed.map((r) => `${r.id} (${r.error ?? `HTTP ${r.status}, quote ${r.status !== null && r.status < 400 ? 'not found' : 'unreadable'}`})`).join(', ')
      const tally = `${confirmed} of ${results.length} confirmed (needs ${minConfirmedRatio})`
      if (confirmedRatio !== undefined && confirmedRatio < minConfirmedRatio) return result('inconclusive', `${tally}; not confirmed now: ${why}`)
      return result('pass', unconfirmed.length ? `${tally}; accepted with unconfirmed: ${why}` : `all ${results.length} quote(s) found at their URLs`)
    },
  }
}
