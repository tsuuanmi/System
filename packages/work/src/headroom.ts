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

export interface RankInput {
  ref: string
  /** The Account to prefer while it is under the ceiling. */
  priority?: 'primary' | 'secondary'
  /** Absent for an Account that has no quota (a `web` Account): it ranks as unreadable. */
  quota?: QuotaReading
}

export interface Ranking {
  /** The Account that takes the step; absent when every reading is over the ceiling (see `wait`). */
  selected?: string
  /** Why each Account ranks where it does, by ref. */
  reasons: Map<string, string>
  /** Every Account is over the ceiling and none unreadable: the step waits, until `resetsAt` if known. */
  wait?: { ref: string; resetsAt?: string }
}

const NAMES = { five_hour: '5h', seven_day: '7d' } as const
const shown = (n: number) => `${Math.round(n * 100) / 100}%`

/** `inputs` are the free, capable Accounts in profile (registration) order. A window at the ceiling is over it. */
export function rankByHeadroom(inputs: readonly RankInput[], ceiling = DEFAULT_QUOTA_CEILING_PERCENT): Ranking {
  const reasons = new Map<string, string>()
  const blind: string[] = []
  const under: { ref: string; headroom: number; primary: boolean }[] = []
  let wait: Ranking['wait']
  for (const { ref, priority, quota } of inputs) {
    const windows = quota && 'windows' in quota ? (Object.entries(quota.windows) as [keyof typeof NAMES, QuotaWindowReading | undefined][]).filter((w): w is [keyof typeof NAMES, QuotaWindowReading] => !!w[1]) : []
    if (!windows.length) {
      reasons.set(ref, quota && 'unreadable' in quota ? `quota unreadable: ${quota.unreadable}` : quota ? 'quota unreadable: no window reported' : 'no quota reading')
      blind.push(ref)
      continue
    }
    const text = (list: typeof windows) => list.map(([name, w]) => `${NAMES[name]} ${shown(w.percentUsed)}`).join(', ')
    const over = windows.filter(([, w]) => w.percentUsed >= ceiling)
    if (over.length) {
      reasons.set(ref, `over ${ceiling}% (${text(over)})`)
      // It is free again when its last over window resets; unknown if any of them has no reset.
      const times = over.map(([, w]) => w.resetsAt && Date.parse(w.resetsAt))
      const resetsAt = times.every((t) => typeof t === 'number' && !Number.isNaN(t)) ? new Date(Math.max(...(times as number[]))).toISOString() : undefined
      if (!wait || (resetsAt && (!wait.resetsAt || resetsAt < wait.resetsAt))) wait = { ref, ...(resetsAt ? { resetsAt } : {}) }
      continue
    }
    const headroom = 100 - Math.max(...windows.map(([, w]) => w.percentUsed))
    const primary = priority === 'primary'
    reasons.set(ref, primary ? `primary under ${ceiling}% (${text(windows)})` : `headroom ${shown(headroom)} (${text(windows)})`)
    under.push({ ref, headroom, primary })
  }
  const best = under.find((a) => a.primary) ?? under.reduce<(typeof under)[number] | undefined>((top, a) => (!top || a.headroom > top.headroom ? a : top), undefined)
  const selected = best?.ref ?? blind[0]
  return { ...(selected ? { selected } : {}), reasons, ...(!selected && wait ? { wait } : {}) }
}
