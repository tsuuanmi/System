/**
 * The five measures of effect over a range of Works (Item fl-11, PLAN section 2), computed from the Host's records,
 * never by hand; records are only read. A measure with nothing to divide by, or an input nobody gave, is `unknown`,
 * never zero. Admission decides the range: `since` inclusive, `until` exclusive.
 */
import { costCoverage, type CostCoverage } from './usage.ts'
import type { WorkRecord } from './record.ts'
import { failureClass, parseCheckFailure } from './failure-class.ts'
import { laterPasses } from './later-pass.ts'
import { summarize, type ClassifiedLookup } from './summary.ts'
import { mergeCommitOf, wasMerged } from './status.ts'
import type { DefectWithdrawal, EscapedDefect } from './defect.ts'
import type { CoreLines } from './core-lines.ts'

export type Unknown = 'unknown'
export interface RangeOptions {
  since: string
  until?: string
  /** An explicit count of Escaped defects that replaces the recorded ones; the report labels it `override (--escaped)`. */
  escaped?: number
  /** The recorded `escaped-defect@1` Artifacts (ms-1): those whose Item or merge commit was merged in the range are the Escaped defects of the range. Without them (and without `escaped`) that measure is `unknown`. */
  defects?: readonly (EscapedDefect & { id?: string })[]
  /** The recorded `escaped-defect-withdrawal@1` contents (def-2): a defect they name is not counted. */
  withdrawals?: readonly DefectWithdrawal[]
  /** The recorded Classifications (cls-1): the `unknown` failures that have one are told apart in `classifiedUnknownFailures`; no measure changes. */
  classified?: ClassifiedLookup
  /** The stored `intent@1` Artifacts (when stored, who settled): those with `settledBy: 'operator'` stored in the range are operator acts. */
  intents?: readonly { at: string; settledBy?: 'operator' }[]
  /** The stored `confirmation@1` Artifacts: those dated in the range are operator acts. */
  confirmations?: readonly { date: string }[]
  /** The merge times of `dev` into `main` in the repositories the Host knows Items for (`releasesOf`): those in the range are operator acts. */
  releases?: readonly string[]
  /** ms-4: the merge times of releases made by a caller under the delegation of PLAN (`releasesBy`): those in the range are reported apart (`headline.releasesByCaller`) and are not operator acts. */
  callerReleases?: readonly string[]
  /** The active core's lines at the range's start and end (`activeCoreLines`, from git); a trend, never a gate (ADR-0015). */
  activeCoreLines?: CoreLines
  /** ct-2 (ADR-0014): the names of the checks whose `on:` lacks `pull_request` (a Work's checks step skips them); a failed `release` verdict on one is a late-caught defect. Without it none is counted. */
  lateChecks?: ReadonlySet<string>
}

export interface RangeReport {
  since: string
  until?: string
  works: number
  /** Works accepted (`succeeded`) over Works ended (`succeeded`, `failed`, `cancelled`; a running or held Work has not ended). */
  verifiedSuccessRate: { rate: number | Unknown; accepted: number; ended: number }
  /** Failures (not operator touches) whose class, by `failureClass` (the Outside cause, else the check and first failing test), occurred in an earlier Work of the range, over all failures; failures of `unknown` cause are counted apart (`unknownFailures`), in neither. */
  recurringFailureRate: { rate: number | Unknown; recurring: number; failures: number }
  unknownFailures: number
  /** The active core's lines (.ts of packages/work/src and packages/artifacts/src on `dev`) at the range's start and end; `unknown` without git. A trend (ADR-0015). */
  activeCoreLines: CoreLines
  /** The failure classes (as `failureClass`; `unknown` is one class) seen 2 or more times in the range, most frequent first (ties: latest example first), at most 10; `example` is the latest Work that had the class. Turn each into a root-cause Item. */
  recurringClasses: { class: string; count: number; example: string }[]
  /** Of those, the ones a Classification labels, by label; absent when none (the Classifier row is off, or has classified none). */
  classifiedUnknownFailures?: Record<string, number>
  /** The headline measure (Charter): distinct Items merged (verified, then merged) per operator act; `operatorActs` is the sum of `parts` (`releasesByCaller` is apart, not counted): Intents the operator settled, confirmations, releases, and the human touches `summarize` counts (human callers only). With no acts `itemsPerAct` is `no acts`, never Infinity. */
  headline: { itemsMerged: number; parts: { intentsSettled: number; confirmations: number; releases: number; humanTouches: number }; operatorActs: number; itemsPerAct: number | 'no acts'; releasesByCaller: number }
  /** Escaped defects over distinct Items merged; `source` says where the count comes from: recorded `escaped-defect@1` Artifacts, the `--escaped` override, or `none` (no input). */
  escapedDefectRate: { rate: number | Unknown; escaped: number | Unknown; itemsMerged: number; source: 'records' | 'override (--escaped)' | 'none' }
  /** ct-2 (ADR-0014): failed release verdicts (criteria `repo-checks-release-v1`) whose failing check the Works skip (`on:` without `pull_request`), with the check names; the trade-off of tiers by event, made visible. */
  lateCaughtDefects: { count: number; checks: string[] }
  /** The API-equivalent cost estimate of every attempt in the range that reports one, over accepted Works; a lower bound when `worksWithUnknownCost` is above 0, `unknown` when no cost is known. */
  costPerVerifiedWork: { usd: number | Unknown; knownCostUsd: number; accepted: number; worksWithUnknownCost: number }
  /** usage-1: attempts of the range per Runtime by usage outcome (`known`: tokens and cost; `partial`: tokens without cost or cache split; `unavailable`: none), so cost the Runtime did not report is not read as zero. */
  costCoverage: CostCoverage
  /** Admission to acceptance of the accepted Works. */
  timeToVerifiedResolution: { medianMs: number | Unknown; p90Ms: number | Unknown; accepted: number }
  /** rounds-1: reopened steps per Work and in total; `medianToPass`/`p90ToPass` are over the succeeded Works (rounds before success); `failedAfterCap` are the failed Works that were automatically reopened (develop.yaml `retry max`) and still failed. */
  reopenRounds: { total: number; perWork: { work: string; rounds: number; status: WorkRecord['state']['status'] }[]; passed: number; medianToPass: number | Unknown; p90ToPass: number | Unknown; failedAfterCap: string[] }
  /** Mean of the attempts' tool-seconds per second (the record's `toolShare`): parallel tool calls overlap, so it is not a share and can pass 1. */
  toolSecondsPerSecond: { mean: number | Unknown; attempts: number }
}

const ratio = (n: number, d: number): number | Unknown => (d === 0 ? 'unknown' : n / d)
const ms = (iso: string) => Date.parse(iso)
/** Nearest-rank percentile of a sorted list. */
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!

export function rangeReport(records: readonly WorkRecord[], { since, until, escaped, defects: recordedDefects, withdrawals, classified, intents, confirmations, releases, callerReleases, activeCoreLines, lateChecks }: RangeOptions): RangeReport {
  const inRange = records
    .filter((r) => r.events[0]!.at >= since && (until === undefined || r.events[0]!.at < until))
    .sort((a, b) => ms(a.events[0]!.at) - ms(b.events[0]!.at))
  const later = laterPasses(records)
  let accepted = 0
  let ended = 0
  let failures = 0
  let recurring = 0
  let unknownFailures = 0
  const classifiedUnknown: Record<string, number> = {}
  let knownCostUsd = 0
  let worksWithUnknownCost = 0
  const seen = new Set<string>()
  const tally = new Map<string, { count: number; example: string; last: number }>()
  const merged = new Set<string>()
  const mergedItems = new Set<string>()
  const mergedCommits: string[] = []
  let operatorTouches = 0
  const resolution: number[] = []
  const rounds: RangeReport['reopenRounds']['perWork'] = []
  const toPass: number[] = []
  const failedAfterCap: string[] = []
  const shares: number[] = []
  const late: string[] = []
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
      if (item) mergedItems.add(item.id)
      const commit = mergeCommitOf(record)
      if (commit) mergedCommits.push(commit)
    }
    const summary = summarize(record, classified, later)
    rounds.push({ work: record.id, rounds: summary.reopenRounds, status })
    if (status === 'succeeded') toPass.push(summary.reopenRounds)
    if (status === 'failed' && record.events.some((e) => e.type === 'reopened' && e.automatic)) failedAfterCap.push(record.id)
    operatorTouches += summary.operatorTouches
    const counted = summary.failures.filter((f) => f.kind !== 'touch')
    unknownFailures += counted.filter((f) => f.unknown).length
    for (const f of counted) if (f.classified) classifiedUnknown[f.classified.label] = (classifiedUnknown[f.classified.label] ?? 0) + 1
    const classes = counted.filter((f) => !f.unknown).map(failureClass)
    failures += classes.length
    recurring += classes.filter((c) => seen.has(c)).length
    for (const c of classes) seen.add(c)
    for (const f of counted) {
      const c = f.unknown ? 'unknown' : failureClass(f)
      const t = tally.get(c)
      tally.set(c, { count: (t?.count ?? 0) + 1, example: record.id, last: ms(record.events[0]!.at) })
    }
    let unknownCost = false
    for (const event of record.events) {
      if (event.type === 'verified' && event.verdict === 'fail' && event.criteria === 'repo-checks-release-v1') {
        const check = parseCheckFailure(event.reason)?.check
        if (check !== undefined && lateChecks?.has(check)) late.push(check)
      }
      if (event.type !== 'observed') continue
      if (event.usage.state === 'observed' && event.usage.costUsd !== undefined) knownCostUsd += event.usage.costUsd
      else unknownCost = true
      if (event.summary && typeof event.summary.toolShare === 'number') shares.push(event.summary.toolShare)
    }
    if (unknownCost) worksWithUnknownCost += 1
  }
  const inRangeAt = (at: string) => at >= since && (until === undefined || at < until)
  const parts = {
    intentsSettled: intents?.filter((i) => i.settledBy === 'operator' && inRangeAt(i.at)).length ?? 0,
    confirmations: confirmations?.filter((c) => inRangeAt(c.date)).length ?? 0,
    releases: releases?.filter(inRangeAt).length ?? 0,
    humanTouches: operatorTouches,
  }
  const operatorActs = parts.intentsSettled + parts.confirmations + parts.releases + parts.humanTouches
  resolution.sort((a, b) => a - b)
  // def-2: a defect another one supersedes (a chain resolves to its latest) or a withdrawal names is not counted.
  const gone = new Set<string>([...(recordedDefects ?? []).flatMap((d) => (d.supersedes ? [d.supersedes] : [])), ...(withdrawals ?? []).map((w) => w.withdraws)])
  const defects = recordedDefects?.filter((d) => d.id === undefined || !gone.has(d.id))
  const recorded = defects?.filter((d) => (d.item !== undefined && mergedItems.has(d.item)) || (d.commit !== undefined && mergedCommits.some((c) => c.startsWith(d.commit!)))).length
  const count = escaped ?? recorded
  toPass.sort((a, b) => a - b)
  const recurringClasses = [...tally].filter(([, t]) => t.count >= 2).sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last).slice(0, 10).map(([c, t]) => ({ class: c, count: t.count, example: t.example }))
  return {
    since, ...(until === undefined ? {} : { until }), works: inRange.length, activeCoreLines: activeCoreLines ?? 'unknown', unknownFailures, recurringClasses, ...(Object.keys(classifiedUnknown).length ? { classifiedUnknownFailures: classifiedUnknown } : {}),
    verifiedSuccessRate: { rate: ratio(accepted, ended), accepted, ended },
    recurringFailureRate: { rate: ratio(recurring, failures), recurring, failures },
    headline: { itemsMerged: merged.size, parts, operatorActs, itemsPerAct: operatorActs === 0 ? 'no acts' : merged.size / operatorActs, releasesByCaller: callerReleases?.filter(inRangeAt).length ?? 0 },
    escapedDefectRate: { rate: count === undefined ? 'unknown' : ratio(count, merged.size), escaped: count ?? 'unknown', itemsMerged: merged.size, source: escaped !== undefined ? 'override (--escaped)' : recorded !== undefined ? 'records' : 'none' },
    lateCaughtDefects: { count: late.length, checks: [...new Set(late)].sort() },
    costCoverage: costCoverage(inRange),
    costPerVerifiedWork: { usd: accepted === 0 || (knownCostUsd === 0 && worksWithUnknownCost > 0) ? 'unknown' : knownCostUsd / accepted, knownCostUsd, accepted, worksWithUnknownCost },
    timeToVerifiedResolution: resolution.length === 0 ? { medianMs: 'unknown', p90Ms: 'unknown', accepted } : { medianMs: (resolution[Math.floor((resolution.length - 1) / 2)]! + resolution[Math.floor(resolution.length / 2)]!) / 2, p90Ms: percentile(resolution, 0.9), accepted },
    reopenRounds: { total: rounds.reduce((n, r) => n + r.rounds, 0), perWork: rounds, passed: toPass.length, medianToPass: toPass.length === 0 ? 'unknown' : (toPass[Math.floor((toPass.length - 1) / 2)]! + toPass[Math.floor(toPass.length / 2)]!) / 2, p90ToPass: toPass.length === 0 ? 'unknown' : percentile(toPass, 0.9), failedAfterCap },
    toolSecondsPerSecond: { mean: shares.length === 0 ? 'unknown' : shares.reduce((a, b) => a + b, 0) / shares.length, attempts: shares.length },
  }
}
