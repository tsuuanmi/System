// Ported from System 1 (tsuuanmi/system @ f199a277): packages/provider-core/src/web-turns.ts. Changes: packages/web-driver/README.md.
/**
 * What the driver's reads of a Deep research report share, with no page or UI engine in them: the
 * run's state and a report's `Sources:` list.
 */

/** A Deep research run as the page shows it. */
export interface ResearchState {
  running: boolean
  done: boolean
  text: string
  /** What the run shows while it works (its activity), when it shows any: a change is progress. */
  progress?: string
}

/**
 * A report followed by its sources (href → title, first title wins), since report text keeps only
 * labels. A title that only repeats the link (the URL itself, or its site, as source pills show
 * it) is left out.
 */
export function withSources(text: string, sources: ReadonlyMap<string, string>): string {
  return `${text}\n\nSources:\n${[...sources].map(([href, title]) => `- ${title && !repeatsLink(title, href) ? `${title} ` : ''}${href}`).join('\n')}`
}

/** Whether a link's title is only its URL or its site ("sqlite.org" of https://www.sqlite.org/wal.html). */
function repeatsLink(title: string, href: string): boolean {
  const bare = (s: string): string => withoutTrailing(s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, ''), '/')
  let host = ''
  try {
    host = new URL(href).hostname
  } catch {
    // Not a URL: only the text itself can match.
  }
  return bare(title) === bare(href) || (host !== '' && bare(title) === bare(host))
}

/** A URL without its `utm_*` tracking parameters, which sites add to the links they cite. */
export function withoutTracking(href: string): string {
  try {
    const url = new URL(href)
    const tracking = Array.from(url.searchParams.keys()).filter((key) => key.startsWith('utm_'))
    for (const key of tracking) url.searchParams.delete(key)
    return url.href
  } catch {
    return href
  }
}

/** Markdown with tracking parameters dropped from its link and reference targets (`](url`, `]: url`). */
export function withoutTrackingLinks(markdown: string): string {
  return markdown.replace(/(\]\(<?|^ {0,3}\[[^\]\n]+\]:[ \t]*<?)(https?:\/\/[^\s)>"]+)/gm,
    (_, lead: string, url: string) => lead + (/[?&]utm_/.test(url) ? withoutTracking(url) : url))
}

/**
 * Text without the run of `chars` at its end, by one backward scan: a `[…]+$` regex is retried at
 * every position of a long run that something else ends, which is quadratic on page text.
 */
function withoutTrailing(text: string, chars: string): string {
  let end = text.length
  while (end > 0 && chars.includes(text[end - 1]!)) end--
  return text.slice(0, end)
}

/** A URL as compared for presence: no tracking parameters, no final slash or trailing punctuation. */
const comparable = (url: string): string => withoutTracking(withoutTrailing(url, '.,;:!?')).replace(/\/$/, '')

/**
 * An answer followed by the sources (href → title) its text does not already carry, without
 * tracking parameters; the text alone when it carries them all. A source is carried only by a URL
 * in the text that is the same once tracking parameters, a final slash (a page reports
 * `https://a.example/` for the text's `https://a.example`), and trailing punctuation are set aside.
 */
export function withMissingSources(text: string, sources: ReadonlyMap<string, string>): string {
  const carried = new Set((text.match(/https?:\/\/[^\s)>"\]]+/g) ?? []).map(comparable))
  const missing = new Map<string, string>()
  for (const [href, title] of sources) {
    const clean = withoutTracking(href)
    if (!carried.has(comparable(clean)) && !missing.has(clean)) missing.set(clean, title)
  }
  return missing.size ? withSources(text, missing) : text
}
