/**
 * The five measures of effect over a range of Works (Item fl-11, PLAN section 2), computed from the Host's records,
 * never by hand; records are only read. A measure with nothing to divide by, or an input nobody gave, is `unknown`,
 * never zero. Admission decides the range: `since` inclusive, `until` exclusive.
 */
import type { WorkRecord } from './record.ts'
import { summarize } from './summary.ts'
import { wasMerged } from './status.ts'

export type Unknown = 'unknown'
export interface RangeOptions {
  since: string
  until?: string
  /** Escaped defects of the range, counted by hand in PLAN section 2. */
  escaped?: number
}

export interface RangeReport {
  since: string
  until?: string
  works: number
  /** Works accepted (`succeeded`) over Works ended (`succeeded`, `failed`, `cancelled`; a running or held Work has not ended). */
  verifiedSuccessRate: { rate: number | Unknown; accepted: number; ended: number }
  /** Failures (not operator touches) whose class, by tr-3's classifier (the Outside cause, else `change-<kind>`), occurred in an earlier Work of the range, over all failures. */
  recurringFailureRate: { rate: number | Unknown; recurring: number; failures: number }
  /** Escaped defects over distinct Items merged. */
  escapedDefectRate: { rate: number | Unknown; escaped: number | Unknown; itemsMerged: number }
  /** The API-equivalent cost estimate of every attempt in the range that reports one, over accepted Works; a lower bound when `worksWithUnknownCost` is above 0, `unknown` when no cost is known. */
  costPerVerifiedWork: { usd: number | Unknown; knownCostUsd: number; accepted: number; worksWithUnknownCost: number }
  /** Admission to acceptance of the accepted Works. */
  timeToVerifiedResolution: { medianMs: number | Unknown; p90Ms: number | Unknown; accepted: number }
  /** Mean tool share of the attempts whose summary (fl-4) knows it. */
  toolShare: { mean: number | Unknown; attempts: number }
}

const ratio = (n: number, d: number): number | Unknown => (d === 0 ? 'unknown' : n / d)
const ms = (iso: string) => Date.parse(iso)
/** Nearest-rank percentile of a sorted list. */
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!

export function rangeReport(records: readonly WorkRecord[], { since, until, escaped }: RangeOptions): RangeReport {
  const inRange = records
    .filter((r) => r.events[0]!.at >= since && (until === undefined || r.events[0]!.at < until))
    .sort((a, b) => ms(a.events[0]!.at) - ms(b.events[0]!.at))
  let accepted = 0
  let ended = 0
  let failures = 0
  let recurring = 0
  let knownCostUsd = 0
  let worksWithUnknownCost = 0
  const seen = new Set<string>()
  const merged = new Set<string>()
  const resolution: number[] = []
  const shares: number[] = []
  for (const record of inRange) {
    const status = record.state.status
    if (status !== 'running' && status !== 'held') ended += 1
    if (status === 'succeeded') {
      accepted += 1
      resolution.push(ms(record.events.at(-1)!.at) - ms(record.events[0]!.at))
    }
    if (wasMerged(record)) {
      const first = record.events[0]!
      const item = first.type === 'admitted' ? first.item : undefined
      merged.add(item ? `${item.repository}\0${item.id}` : record.id)
    }
    const classes = summarize(record).failures.filter((f) => f.kind !== 'touch').map((f) => f.outside ?? `change-${f.kind}`)
    failures += classes.length
    recurring += classes.filter((c) => seen.has(c)).length
    for (const c of classes) seen.add(c)
    let unknownCost = false
    for (const event of record.events) {
      if (event.type !== 'observed') continue
      if (event.usage.state === 'observed' && event.usage.costUsd !== undefined) knownCostUsd += event.usage.costUsd
      else unknownCost = true
      if (event.summary && typeof event.summary.toolShare === 'number') shares.push(event.summary.toolShare)
    }
    if (unknownCost) worksWithUnknownCost += 1
  }
  resolution.sort((a, b) => a - b)
  return {
    since, ...(until === undefined ? {} : { until }), works: inRange.length,
    verifiedSuccessRate: { rate: ratio(accepted, ended), accepted, ended },
    recurringFailureRate: { rate: ratio(recurring, failures), recurring, failures },
    escapedDefectRate: { rate: escaped === undefined ? 'unknown' : ratio(escaped, merged.size), escaped: escaped ?? 'unknown', itemsMerged: merged.size },
    costPerVerifiedWork: { usd: accepted === 0 || (knownCostUsd === 0 && worksWithUnknownCost > 0) ? 'unknown' : knownCostUsd / accepted, knownCostUsd, accepted, worksWithUnknownCost },
    timeToVerifiedResolution: resolution.length === 0 ? { medianMs: 'unknown', p90Ms: 'unknown', accepted } : { medianMs: (resolution[Math.floor((resolution.length - 1) / 2)]! + resolution[Math.floor(resolution.length / 2)]!) / 2, p90Ms: percentile(resolution, 0.9), accepted },
    toolShare: { mean: shares.length === 0 ? 'unknown' : shares.reduce((a, b) => a + b, 0) / shares.length, attempts: shares.length },
  }
}
