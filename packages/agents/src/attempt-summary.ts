/**
 * What an attempt did (fl-4) is computed by each Runtime's adapter (adapters/) from the attempt's own output: pure, no clock, no I/O; a part its log
 * does not say is `unknown`, never a guess. Here: the shared helpers, and the bound of the stored log: its head and its tail.
 */
import type { AttemptSummary } from '@system/work'

/** The stored log's size: the first `HEAD_LOG_BYTES` (where the attempt reads the code) and the rest from the end. */
export const MAX_LOG_BYTES = 256 * 1024
export const HEAD_LOG_BYTES = 64 * 1024

/** The head and the tail of `output` with a marker line for the cut; `output` itself when it fits. */
export function boundLog(output: string): string {
  if (output.length <= MAX_LOG_BYTES) return output
  const marker = (cut: number) => `\n[… ${cut} bytes cut by System …]\n`
  const reserve = marker(output.length).length + 8
  const headEnd = output.lastIndexOf('\n', HEAD_LOG_BYTES) + 1 || HEAD_LOG_BYTES
  const tailBytes = MAX_LOG_BYTES - headEnd - reserve
  let tailStart = output.length - tailBytes
  const newline = output.indexOf('\n', tailStart)
  if (newline >= 0 && newline - tailStart < 4096) tailStart = newline + 1
  return output.slice(0, headEnd) + marker(tailStart - headEnd) + output.slice(tailStart)
}

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
