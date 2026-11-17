/**
 * The input of the `failure-cause` question (cls-3, Q41): the Work's evidence, not only the failure's reason. The reason
 * names the first failing test and can hide the decisive failure, so the text also gives each check's result on the change
 * and on the base re-run, whether a later verdict passed the same content, and what the next attempt of the step reported.
 * Built from the record alone, so the same record gives the same text (and the same hash).
 */
import type { Failure, LaterPass, WorkEvent, WorkRecord } from '@system/work'

const MAX = 1200
const clip = (text: string): string => (text.length > MAX ? `${text.slice(0, MAX)}…` : text)

/** The change a failure is about: the subject of its verdict, else the previous change of the step's last reopening, else the attempt's first output. */
function changeOf(events: readonly WorkEvent[], index: number): string | undefined {
  const event = events[index]
  if (event?.type === 'verified') return event.subject
  if (event?.type === 'observed') {
    const reopened = events.slice(0, index).findLast((e) => e.type === 'reopened' && e.stepId === event.stepId)
    return Object.values(event.outputs)[0] ?? (reopened?.type === 'reopened' ? reopened.previous : undefined)
  }
  return undefined
}

/** The evidence text of `failure` (read from `record.events[failure.event index]`); `later` (cls-5) adds a pass of the same change in a later Work. */
export function failureEvidence(failure: Pick<Failure, 'event' | 'kind' | 'reason'>, record: WorkRecord, later?: LaterPass): string {
  const index = Number(failure.event.split('#')[1])
  const events = record.events
  const lines = [`failure: ${failure.kind}: ${clip(failure.reason)}`]
  const change = Number.isInteger(index) ? changeOf(events, index) : undefined
  if (change) {
    const results = events.filter((e): e is Extract<WorkEvent, { type: 'verified' }> => e.type === 'verified' && e.subject === change)
    if (results.length) {
      lines.push('checks on the change:')
      for (const v of results) {
        const base = /the base fails it too/i.test(v.reason) ? ' [includes the base re-run]' : ''
        lines.push(`- ${v.stepId}: ${v.verdict}${v.rerunOf ? ' (re-run of the same change)' : ''}${base}: ${clip(v.reason)}`)
      }
    }
    const passed = events.slice(index + 1).some((e) => e.type === 'verified' && e.verdict === 'pass' && e.subject === change)
    lines.push(`a later verdict passed the same content: ${passed ? 'yes' : 'no'}`)
    const stepId = events[index]?.type === 'verified' ? events[index].stepId : undefined
    const elsewhere = later?.(change, stepId, record, index)
    if (elsewhere) lines.push(`the same change passed ${elsewhere.check} later in ${elsewhere.work}`)
  }
  const failed = events[index]
  if (failed && 'stepId' in failed) {
    const next = events.slice(index + 1).find((e) => e.type === 'observed' && e.stepId === failed.stepId)
    if (next?.type === 'observed') lines.push(`next attempt of ${failed.stepId}: ${next.status}${next.reason ? `: ${clip(next.reason)}` : ''}`)
  }
  return lines.join('\n')
}
