/**
 * Item hold-1 (RES-0016): what a held Work awaits, stated for the Operator: the step, the reason, the commit or Artifact,
 * the options and the exact command for each. A pure function of the record; it only prints, no agent can answer it
 * (`approve` and `deny` stay a human's at a terminal).
 */
import { OUTSIDE_HOLD } from './outside.ts'
import type { WorkRecord } from './record.ts'

/** The decision text of a held Work, or undefined when the Work is not held. */
export function holdDecision(record: Pick<WorkRecord, 'id' | 'state'>): string | undefined {
  const { state, id } = record
  const steps = state.steps ?? {}
  const effects = Object.values(state.effects ?? {})
  if (state.status !== 'held') return undefined
  const step = state.awaiting
  const entry = step ? steps[step] : undefined
  const unknown = effects.find((e) => e.state === 'unknown')
  const heldEffect = step ? effects.find((e) => e.stepId === step && e.held) : undefined
  const outside = (entry?.outside?.count ?? 0) >= OUTSIDE_HOLD
  const lines = ['Decision needed', `  step:   ${step ?? unknown?.stepId ?? 'none recorded'}`, `  reason: ${state.reason ?? 'no reason recorded'}`]
  const options: string[] = []
  if (heldEffect?.held) lines.push(`  commit: ${heldEffect.held}`)
  else if (entry?.subject) lines.push(`  subject: ${entry.subject} (verdict ${entry.verdict ?? 'none'})`)
  else if (step && !outside) lines.push(`  artifact: ${Object.values(entry?.outputs ?? {}).join(', ') || 'none recorded'}`)
  if (step && !outside) {
    options.push(`  approve it:   system approve ${id}`, `  deny it (the Work fails):   system deny ${id} --reason <why>`)
  }
  const retryStep = step ?? unknown?.stepId
  options.push(retryStep ? `  run the step again:   system work retry ${id} --step ${retryStep}` : `  run it again:   system work run ${id}`)
  return `${[...lines, 'Options', ...options].join('\n')}\n`
}
