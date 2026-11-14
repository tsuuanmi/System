/**
 * The reasons that mean an Account is out of quota or credits (sc-14): the one list. An attempt that
 * failed with such a reason is recorded as `limited`, not failed; the step is routed again.
 */
export const QUOTA_LIMITED = /rate.?limit|too many requests|\b429\b|usage limit|out of credits|quota exceeded/i

export const isQuotaLimited = (reason?: string): boolean => QUOTA_LIMITED.test(reason ?? '')

/** How long an Account is out when the error says nothing of its reset (the 5-hour window). */
export const DEFAULT_LIMIT_MS = 5 * 3_600_000
/** A reset further than this from now is not believed. */
const MAX_RESET_MS = 8 * 86_400_000

/**
 * When the error text says the quota resets, as epoch milliseconds in (now, now + 8 days]: an ISO time, a Unix time after `|`,
 * "in N hours|minutes", or "resets 3pm" (the next such time, UTC when the text says so, else local). Undefined otherwise.
 */
export function quotaResetFrom(reason: string | undefined, now: number): number | undefined {
  const text = reason ?? ''
  const candidates: number[] = []
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/.exec(text)?.[0]
  if (iso) candidates.push(Date.parse(iso))
  const unix = /\|(\d{10})\b/.exec(text)?.[1]
  if (unix) candidates.push(Number(unix) * 1000)
  const relative = /\bin (\d+(?:\.\d+)?) (hours?|minutes?|mins?)\b/i.exec(text)
  if (relative) candidates.push(now + Number(relative[1]) * (/^h/i.test(relative[2]!) ? 3_600_000 : 60_000))
  const clock = /\bresets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text)
  if (clock) {
    const hour = Number(clock[1]) % 12 + (clock[3]!.toLowerCase() === 'pm' ? 12 : 0)
    const minute = Number(clock[2] ?? 0)
    const utc = /\(UTC\)/i.test(text)
    const at = new Date(now)
    if (utc) at.setUTCHours(hour, minute, 0, 0)
    else at.setHours(hour, minute, 0, 0)
    if (at.getTime() <= now) at.setTime(at.getTime() + 86_400_000)
    candidates.push(at.getTime())
  }
  return candidates.find((at) => Number.isFinite(at) && at > now && at <= now + MAX_RESET_MS)
}
