/**
 * Routing by headroom (PLAN SC, sc-4): which free, capable Account takes a step, from the quota
 * readings the controller was handed. Pure: it reads nothing, so the reasons it returns are the
 * whole record of the choice and replay never asks a provider again.
 */

/** One window as a Worker's `quota()` tells it (structurally `@system/agents`' `QuotaWindow`). */
interface QuotaWindowReading {
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

interface Ranking {
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

/** One Account for `roomOf`: whether it has a free slot, and what `rankByHeadroom` reads of it. */
interface RoomAccount {
  ref: string
  /** Running attempts are under its `maxConcurrentAttempts`. */
  slot: boolean
  reading: QuotaReading | undefined
  ceiling: number
}

/**
 * How many Accounts could take one more parallel Work now (information for the caller; the Host never picks an Item): a free slot,
 * and every window under the Ceiling, as `rankByHeadroom` reads them. An Account with no readable quota counts as free when it
 * has a slot, and is listed in `unknown`.
 */
export function roomOf(accounts: readonly RoomAccount[]): { accounts: number; free: number; unknown: string[] } {
  const open = accounts.filter((a) => a.slot)
  const ranked = rankByHeadroom(open.map((a) => ({ ref: a.ref, attempts: 0, reading: a.reading, ceiling: a.ceiling })))
  const free = open.filter((a) => /^headroom |^no quota reader$|^quota unreadable/.test(ranked.reasons[a.ref] ?? ''))
  return { accounts: accounts.length, free: free.length, unknown: free.filter((a) => !/^headroom /.test(ranked.reasons[a.ref]!)).map((a) => a.ref) }
}
