/**
 * Whether a recorded failure reason is an Outside failure (GLOSSARY): machine
 * load or a timeout, an Account's quota or rate limit, a Host restart or a lost
 * attempt, a conflict with other work at publish, a slow Host. Deterministic
 * from the reason text; a reason no pattern knows is a failure of the change
 * (`undefined`). The patterns live here and nowhere else.
 */
export type OutsideCause = 'quota' | 'restart' | 'conflict' | 'load' | 'slow-host'

const PATTERNS: [OutsideCause, RegExp][] = [
  ['quota', /out of credits|rate[- ]limit|quota|usage limit|too many requests/i],
  ['restart', /host stopped before the attempt reported|host restart/i],
  ['conflict', /merge conflict with /i],
  ['load', /the base fails it too/i],
  ['slow-host', /timed out after|timeout/i],
]

export function outsideCause(reason: string): OutsideCause | undefined {
  return PATTERNS.find(([, pattern]) => pattern.test(reason))?.[0]
}
