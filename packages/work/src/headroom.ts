/**
 * Routing by headroom (PLAN SC, sc-4): which free, capable Account takes a step, from the quota
 * readings the controller was handed. Pure: it reads nothing, so the reasons it returns are the
 * whole record of the choice and replay never asks a provider again.
 */

/** One window as a Worker's `quota()` tells it (structurally `@system/agents`' `QuotaWindow`). */
export interface QuotaWindowReading {
  /** 0 to 100. */
  percentUsed: number
  resetsAt?: string
}

/** A reading, or why there is none (structurally `QuotaReport`). */
export type QuotaReading =
  | { windows: { five_hour?: QuotaWindowReading; seven_day?: QuotaWindowReading } }
  | { unreadable: string }

export const DEFAULT_QUOTA_CEILING_PERCENT = 80

/** A free, capable Account, in profile (registration) order. */
export interface Candidate {
  ref: string
  /** Attempts the Account took this UTC day: the tie-break after equal headroom. */
  attempts: number
  /** Absent for an Account that has no quota reader (a `web` Account): it ranks as unreadable. */
  reading: QuotaReading | undefined
  /** The share of a window (percent used) from which the Account is over. */
  ceiling: number
}

export interface Ranking {
  /** The Account that takes the step; absent when every reading is over the ceiling (see `waitUntil`). */
  selected?: string
  /** Why each Account ranks where it does, by ref. */
  reasons: Record<string, string>
  /** Every Account is over the ceiling and none unreadable: the step waits, until `resetsAt` if one is known. */
  waitUntil?: { resetsAt?: string }
}

const NAMES = { five_hour: '5h', seven_day: '7d' } as const
const shown = (n: number) => `${Math.round(n * 100) / 100}%`
type Window = [keyof typeof NAMES, QuotaWindowReading]

/** A window at the ceiling is over it. */
export function rankByHeadroom(candidates: readonly Candidate[]): Ranking {
  const reasons: Record<string, string> = {}
  const blind: { ref: string; attempts: number }[] = []
  const under: { ref: string; headroom: number; attempts: number }[] = []
  const waits: { resetsAt?: string; at?: number }[] = []
  for (const { ref, attempts, reading, ceiling } of candidates) {
    const windows = reading && 'windows' in reading ? (Object.entries(reading.windows) as [keyof typeof NAMES, QuotaWindowReading | undefined][]).filter((w): w is Window => !!w[1]) : []
    if (!windows.length) {
      reasons[ref] = !reading ? 'no quota reader' : 'unreadable' in reading ? `quota unreadable: ${reading.unreadable}` : 'quota unreadable: no window reported'
      blind.push({ ref, attempts })
      continue
    }
    const text = (list: Window[]) => list.map(([name, w]) => `${NAMES[name]} ${shown(w.percentUsed)}`).join(', ')
    const over = windows.filter(([, w]) => w.percentUsed >= ceiling)
    if (over.length) {
      reasons[ref] = `over ${ceiling}% (${text(over)})`
      // It is free again when its last over window resets; unknown if any of them has no usable reset.
      const stamps = over.map(([, w]) => ({ resetsAt: w.resetsAt, at: w.resetsAt ? Date.parse(w.resetsAt) : NaN }))
      const last = stamps.every((s) => !Number.isNaN(s.at)) ? stamps.reduce((a, b) => (b.at > a.at ? b : a)) : undefined
      waits.push(last ?? {})
      continue
    }
    const headroom = 100 - Math.max(...windows.map(([, w]) => w.percentUsed))
    reasons[ref] = `headroom ${shown(headroom)} (${text(windows)})`
    under.push({ ref, headroom, attempts })
  }
  // Most headroom, then fewest attempts that day, then registration order (strict comparisons keep the first).
  const best = under.reduce<(typeof under)[number] | undefined>((top, a) => (!top || a.headroom > top.headroom || (a.headroom === top.headroom && a.attempts < top.attempts) ? a : top), undefined)
  const selected = best?.ref ?? blind.reduce<(typeof blind)[number] | undefined>((top, a) => (!top || a.attempts < top.attempts ? a : top), undefined)?.ref
  if (selected) return { selected, reasons }
  if (!waits.length) return { reasons }
  const known = waits.filter((w): w is { resetsAt: string; at: number } => w.at !== undefined)
  const earliest = known.length ? known.reduce((a, b) => (b.at < a.at ? b : a)) : undefined
  return { reasons, waitUntil: earliest ? { resetsAt: earliest.resetsAt } : {} }
}
