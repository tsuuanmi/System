/**
 * A Work's measurements, derived from its events (mvp.md failure test 8,
 * MVP-06): duration, attempts, the operator's touches, and usage. Submitting
 * Work is the request itself, not a touch; a human cancel, retry or decision
 * is. Usage an attempt did not report, or did not split into cache and fresh input, is counted apart, never as zero.
 */
import type { WorkRecord } from './record.ts'

export interface WorkSummary {
  id: string
  status: WorkRecord['state']['status']
  durationMs: number
  attempts: number
  operatorTouches: number
  touches: string[]
  /** `inputTokens` is the total; fresh input counts only attempts that split their cache use. */
  usage: {
    inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; freshInputTokens: number; outputTokens: number
    observedAttempts: number; unsplitAttempts: number; unknownAttempts: number
  }
}

export function summarize(record: WorkRecord): WorkSummary {
  const touches: string[] = []
  const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, freshInputTokens: 0, outputTokens: 0, observedAttempts: 0, unsplitAttempts: 0, unknownAttempts: 0 }
  let attempts = 0
  for (const event of record.events) {
    if (event.type === 'dispatched' && event.executor === 'worker') attempts += 1
    if (event.type === 'observed') {
      if (event.usage.state === 'observed') {
        usage.inputTokens += event.usage.inputTokens
        usage.outputTokens += event.usage.outputTokens
        usage.observedAttempts += 1
        const { cacheReadTokens, cacheWriteTokens = 0 } = event.usage
        if (cacheReadTokens === undefined) {
          usage.unsplitAttempts += 1
        } else {
          usage.cacheReadTokens += cacheReadTokens
          usage.cacheWriteTokens += cacheWriteTokens
          usage.freshInputTokens += event.usage.inputTokens - cacheReadTokens - cacheWriteTokens
        }
      } else {
        usage.unknownAttempts += 1
      }
    }
    if (event.type === 'terminal' && event.outcome === 'cancelled' && event.caller?.type === 'human') touches.push('cancel')
    if (event.type === 'reopened' && event.caller.type === 'human') touches.push(`retry ${event.stepId}`)
    if (event.type === 'decided') touches.push(`${event.decision} ${event.stepId}`)
  }
  const first = Date.parse(record.events[0]!.at)
  const last = Date.parse(record.events.at(-1)!.at)
  return { id: record.id, status: record.state.status, durationMs: last - first, attempts, operatorTouches: touches.length, touches, usage }
}
