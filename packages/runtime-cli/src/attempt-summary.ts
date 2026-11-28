/**
 * What an attempt did (fl-4) is computed by each Runtime's adapter (adapters/) from the attempt's own output: pure, no clock, no I/O; a part its log
 * does not say is `unknown`, never a guess. Here: the shared helpers.
 */
import type { AttemptSummary } from '@system/work'

const UNKNOWN = 'unknown' as const

/** An attempt summary with every part unknown: a Runtime whose log does not say something reports `unknown` for it, never a guess. */
export const unknownSummary = (runtime: AttemptSummary['runtime']): AttemptSummary => ({ runtime, toolCalls: UNKNOWN, filesRead: UNKNOWN, filesEdited: UNKNOWN, longest: [], toolSeconds: UNKNOWN, toolShare: UNKNOWN, durationMs: UNKNOWN, numTurns: UNKNOWN })

/** The JSON object lines of an output. */
export const jsonEvents = (output: string): Array<Record<string, any>> => {
  const found: Array<Record<string, any>> = []
  for (const text of output.split('\n')) {
    if (!text.startsWith('{')) continue
    try {
      const event = JSON.parse(text)
      if (event && typeof event === 'object') found.push(event)
    } catch { /* a line cut by truncation, or not JSON */ }
  }
  return found
}
