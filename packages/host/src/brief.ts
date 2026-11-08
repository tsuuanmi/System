/**
 * The brief of a Goal (PROP-0006 decision 2): what a new Orchestrator session
 * starts from, written from records only, with no model call. The Goal and
 * its budget left; its Works with their status, current step and progress;
 * its decisions; and what waits for someone. Times are written as recorded,
 * never relative to now, so the same records give the same text.
 */
import { TERMINAL, type GoalView, type LiveAttempt, type StoredDecision, type WorkRecord } from '@system/work'

const left = (spent: number, limit: number | undefined, unit: string) => (limit === undefined ? `${unit}: ${spent} spent, no limit` : `${unit}: ${spent} of ${limit} spent, ${Math.max(0, limit - spent)} left`)

/** The step a Work is at: the ones running, else the one it ended on, else the next pending. */
function stepOf(record: WorkRecord): string {
  const steps = Object.entries(record.state.steps)
  const running = steps.filter(([, s]) => s.state === 'running').map(([id]) => id)
  if (running.length) return `step ${running.join(', ')} running`
  if (record.state.awaiting) return `awaits ${record.state.awaiting}`
  const ended = steps.find(([, s]) => s.state === 'failed' || s.state === 'cancelled' || (s.verdict !== undefined && s.verdict !== 'pass'))
  if (ended) {
    // What the step's last attempt said, from its event.
    const last = record.events.findLast((e) => (e.type === 'observed' || e.type === 'verified') && e.stepId === ended[0])
    const said = last?.type === 'verified' ? `verdict ${last.verdict}: ${last.reason}` : last?.type === 'observed' ? last.reason : undefined
    return `step ${ended[0]} ${ended[1].verdict && ended[1].verdict !== 'pass' ? ended[1].verdict : ended[1].state}${said ? ` (${said})` : ''}`
  }
  const next = steps.find(([, s]) => s.state === 'pending')
  return next ? `next step ${next[0]}` : 'every step done'
}

function liveOf(attempt: LiveAttempt): string {
  const p = attempt.progress
  const said = p ? [p.turns !== undefined && `${p.turns} turns`, p.lastTool && `last tool ${p.lastTool}`, p.tokens !== undefined && `${p.tokens} tokens`, p.stage && `stage ${p.stage}`].filter(Boolean).join(', ') : 'no progress reported'
  return `    - ${attempt.stepId} on ${attempt.worker} since ${attempt.startedAt}, last activity ${attempt.lastActivityAt}: ${said}${attempt.stalled ? ' (STALLED)' : ''}`
}

export function brief(view: GoalView, records: WorkRecord[], decisions: StoredDecision[], live: (workId: string) => LiveAttempt[]): string {
  const { current, spend } = view
  const works = [...records].sort((a, b) => (a.events[0]!.at < b.events[0]!.at ? -1 : a.events[0]!.at > b.events[0]!.at ? 1 : a.id < b.id ? -1 : 1))
  const lines = [
    `# Goal ${view.id}`,
    ...(current.id !== view.id ? [`Current version: ${current.id}`] : []),
    `Aim: ${current.goal.aim}`,
    `Scope: ${current.goal.scope}`,
    '',
    '## Budget',
    `- ${left(spend.attempts, current.goal.budget.attempts, 'attempts')}`,
    `- ${left(spend.tokens, current.goal.budget.tokens, 'tokens')}${spend.unknownAttempts ? ` (${spend.unknownAttempts} attempts with unknown usage)` : ''}`,
    '',
    `## Works (${works.length})`,
  ]
  const waiting: string[] = []
  for (const record of works) {
    const { status, reason, awaiting } = record.state
    const step = stepOf(record)
    lines.push(`- ${record.id} ${status}: ${step}${reason && !step.startsWith(reason) ? `; ${reason}` : ''}`)
    const attempts = live(record.id)
    lines.push(...attempts.map(liveOf))
    if (status === 'held') waiting.push(awaiting ? `- approval: ${record.id} awaits ${awaiting}` : `- held: ${record.id}: ${reason ?? ''}`)
    if (status === 'failed') waiting.push(`- failed: ${record.id}: ${reason ?? ''}`)
    if (attempts.some((a) => a.stalled)) waiting.push(`- stalled: ${record.id}`)
    if (!TERMINAL.has(status) && !attempts.length && !Object.values(record.state.steps).some((s) => s.state === 'running')) waiting.push(`- not running: ${record.id} (run it)`)
  }
  lines.push('', `## Decisions (${decisions.length})`)
  for (const d of decisions) lines.push(`- ${d.at} ${d.question} -> ${d.choice}: ${d.reason} (${d.id})${d.restsOn.length ? ` rests on ${d.restsOn.join(', ')}` : ''}`)
  lines.push('', '## Waiting', ...(waiting.length ? waiting : ['- nothing']))
  return `${lines.join('\n')}\n`
}
