/**
 * The status of a project (PLAN DF2c): the Items of a repository's `STATUS.md`
 * (done as it says on the `dev` tip) and the Works that carry them out.
 * Nothing here is stored.
 */
import { git, snapshot } from './git.ts'
import { ITEM_ID } from './kinds.ts'
import type { LiveAttempt } from './live.ts'
import type { WorkEvent, WorkRecord } from './record.ts'

export interface Item {
  id: string
  title: string
  done: boolean
}

export interface ParsedStatus {
  aim: string[]
  items: Item[]
  /** One line for each malformed line: `line N: why`. */
  problems: string[]
}

/** `STATUS.md` is about this long at most; details go elsewhere, as links. */
const MAX_LINES = 100
const MAX_AIM = 3

/** Read a `STATUS.md` leniently: what is well-formed is used, and each line that is not gets a reason. */
export function parseStatus(text: string): ParsedStatus {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const aim: string[] = []
  const items: Item[] = []
  const problems: string[] = []
  let inAim = false
  for (const [n, raw] of lines.entries()) {
    const line = raw.trimEnd()
    const here = `line ${n + 1}`
    const heading = /^Aim:\s*(.*)$/.exec(line)
    if (heading && !aim.length) {
      inAim = true
      if (heading[1]) aim.push(heading[1])
      continue
    }
    if (inAim && line && !/^[#*-]/.test(line)) {
      aim.push(line.trim())
      continue
    }
    inAim = false
    if (!/^[-*]\s/.test(line)) continue
    const item = /^[-*] \[([ xX])\] (\S+)(?:\s+(.*))?$/.exec(line)
    if (!item) {
      problems.push(/^[-*] \[/.test(line) ? `${here}: not an Item line: the box is [ ] or [x], then an ID and a title` : `${here}: not an Item line (- [ ] <id> <title>)`)
    } else if (!ITEM_ID.test(item[2]!)) {
      problems.push(`${here}: ${item[2]} is not an Item ID (lower case, ending in -<number>, such as df-3)`)
    } else if (items.some((i) => i.id === item[2])) {
      problems.push(`${here}: Item ${item[2]} is listed already`)
    } else {
      items.push({ id: item[2]!, title: item[3]?.trim() ?? '', done: item[1] !== ' ' })
      if (!item[3]?.trim()) problems.push(`${here}: Item ${item[2]} has no title`)
    }
  }
  if (!aim.length) problems.push('no Aim: line')
  if (aim.length > MAX_AIM) problems.push(`the aim has ${aim.length} lines; keep it to ${MAX_AIM}`)
  if (lines.length > MAX_LINES) problems.push(`STATUS.md has ${lines.length} lines; keep it to about ${MAX_LINES} and link the details`)
  return { aim, items, problems }
}

export interface StatusFile extends ParsedStatus {
  /** The repository's top level, as a Work's Task records it. */
  repository: string
  /** The `dev` tip it was read at. */
  commit: string
}

/** `STATUS.md` at the `dev` tip of the repository that contains `path`, read from git and never from the working tree. */
export async function readStatus(path: string): Promise<StatusFile> {
  const { repository, commit } = await snapshot(path, 'dev')
  let text: string | undefined
  try {
    text = await git(repository, ['show', `${commit}:STATUS.md`])
  } catch { /* none at that commit */ }
  const parsed = text === undefined ? { aim: [], items: [], problems: [`no STATUS.md on dev (${commit.slice(0, 12)}) in ${repository}`] } : parseStatus(text)
  return { repository, commit, ...parsed }
}

type Admitted = Extract<WorkEvent, { type: 'admitted' }>
export type ItemRef = NonNullable<Admitted['item']>

const itemOf = (record: WorkRecord): ItemRef | undefined => (record.events[0]!.type === 'admitted' ? (record.events[0] as Admitted).item : undefined)
const admittedAt = (record: WorkRecord): string => record.events[0]!.at
const isActive = (record: WorkRecord) => record.state.status === 'running' || record.state.status === 'held'

/** The Works for an Item of a repository, oldest admitted first. */
function worksFor(records: WorkRecord[], item: ItemRef): WorkRecord[] {
  return records.filter((r) => itemOf(r)?.id === item.id && itemOf(r)?.repository === item.repository)
    .sort((a, b) => (admittedAt(a) < admittedAt(b) ? -1 : admittedAt(a) > admittedAt(b) ? 1 : 0))
}

/** A Work for the Item that is running or held, if any. */
export function activeWork(records: WorkRecord[], item: ItemRef): WorkRecord | undefined {
  return worksFor(records, item).find(isActive)
}

/** The Work's current step and the Account (Worker) that has it, as of its last dispatch. */
export function whoHas(record: WorkRecord): { step?: string; account?: string } {
  const last = record.events.findLast((e) => e.type === 'dispatched')
  return last?.type === 'dispatched' ? { step: last.stepId, account: last.selected } : {}
}

const progressText = (attempt: LiveAttempt | undefined): string => {
  if (attempt?.waiting) return `waiting for ${attempt.waiting}`
  const p = attempt?.progress
  const parts = [
    p?.turns !== undefined ? `turns ${p.turns}` : '', p?.lastTool ? `last tool ${p.lastTool}` : '',
    p?.tokens !== undefined ? `${p.tokens} tokens` : '', p?.stage ? `stage ${p.stage}` : '', attempt?.stalled ? 'stalled' : '',
  ].filter(Boolean)
  return parts.join(', ') || 'no live progress'
}

function doing(record: WorkRecord, live: ((workId: string) => LiveAttempt[]) | undefined): string {
  const waiting = live?.(record.id).find((a) => a.waiting)
  const { step, account } = waiting ? { step: waiting.stepId, account: waiting.worker } : whoHas(record)
  const who = step ? `step ${step} on ${account}` : 'no step yet'
  const tail = record.state.status === 'held' ? `held: ${record.state.reason ?? 'no reason recorded'}` : live ? progressText(live(record.id).find((a) => a.stepId === step && (!!a.waiting || !waiting))) : ''
  return `${record.id} ${who} since ${admittedAt(record)}${tail ? `; ${tail}` : ''}`
}

const artifactsOf = (record: WorkRecord): string[] => Object.values(record.state.results)

/**
 * One line per Item, as `[x] <id> <title> - <state>`: `done` (with the last
 * succeeded Work and its Artifacts, when there is one), `doing` (each Work
 * running or held: which step, on which Account, since when, and the progress
 * the Host holds for it, or why it is held) or `todo: nobody`. An Item only
 * the Works name is shown as not in STATUS.md. Without `live`, no progress.
 */
export function itemLines(
  status: Pick<ParsedStatus, 'items'>, repository: string | undefined, records: WorkRecord[],
  live?: (workId: string) => LiveAttempt[], filter: { state?: 'todo' | 'doing' | 'done'; item?: string } = {},
): string[] {
  const listed = new Set(status.items.map((i) => i.id))
  const named = records.flatMap((r) => (itemOf(r)?.repository === repository && isActive(r) ? [itemOf(r)!.id] : []))
  const unlisted = [...new Set([...named, ...(filter.item ? [filter.item] : [])])].filter((id) => !listed.has(id))
  const lines: string[] = []
  for (const item of [...status.items.map((i) => ({ ...i, listed: true })), ...unlisted.map((id) => ({ id, title: '', done: false, listed: false }))]) {
    if (filter.item && item.id !== filter.item) continue
    const works = worksFor(records, { id: item.id, repository })
    const active = works.filter(isActive)
    const state = item.done ? 'done' : active.length ? 'doing' : 'todo'
    if (filter.state && filter.state !== state) continue
    const last = works.findLast((r) => r.state.status === 'succeeded')
    const text = state === 'done'
      ? `done${last ? `; last ${[last.id, ...artifactsOf(last)].join(', ')}` : ''}`
      : state === 'doing' ? `doing: ${active.map((r) => doing(r, live)).join(' | ')}` : 'todo: nobody'
    lines.push(`${item.listed ? `[${item.done ? 'x' : ' '}] ${item.id} ${item.title}` : `${item.id} (not in STATUS.md)`} - ${text}`)
  }
  return lines
}

/** The most recent earlier Works a Worker is told of in detail. */
const MAX_EARLIER = 3

/** One earlier Work as text with IDs: end status and reason, its Task, its changes and commits, and each failed verdict in full. */
function earlierText(r: WorkRecord, commitOf: ((id: string) => string | undefined) | undefined): string[] {
  const reason = r.state.status === 'running' ? `at step ${whoHas(r).step ?? 'none yet'}` : r.state.status === 'succeeded' ? artifactsOf(r).join(', ') : r.state.reason
  const lines = [`- ${r.id} ${r.state.status}${reason ? `: ${reason}` : ''}`]
  if (r.state.input) lines.push(`  Task (read its instructions by this ID): ${r.state.input}`)
  const changes = new Map<string, string>()
  for (const id of [...Object.values(r.state.results), ...Object.values(r.state.steps).flatMap((s) => Object.values(s.outputs))]) {
    const commit = commitOf?.(id)
    if (commit) changes.set(id, commit)
  }
  for (const [id, commit] of changes) lines.push(`  change: Artifact ${id}, commit ${commit}`)
  const last = new Map<string, Extract<WorkEvent, { type: 'verified' }>>()
  for (const e of r.events) if (e.type === 'verified') last.set(e.stepId, e)
  for (const e of last.values()) {
    if (e.verdict === 'pass') continue
    lines.push(`  verify step ${e.stepId} ${e.verdict} (subject ${e.subject}): ${e.reason}`)
    if (e.evidence?.length) lines.push(`  evidence: ${e.evidence.join(', ')}`)
  }
  return lines
}

/** What a Worker is told of an Item beyond its Task: the Item's line, and what each of the last earlier Works did and why it ended. */
export async function itemNote(item: ItemRef, records: WorkRecord[], commitOf?: (id: string) => string | undefined): Promise<string> {
  const status = item.repository ? await readStatus(item.repository).catch(() => undefined) : undefined
  const earlier = worksFor(records, item).slice(-MAX_EARLIER).reverse().flatMap((r) => earlierText(r, commitOf))
  return [
    `Item ${item.id}${item.repository ? ` of ${item.repository}` : ''}, from STATUS.md on dev:`,
    itemLines(status ?? { items: [] }, item.repository, records, undefined, { item: item.id })[0]!,
    '',
    ...(earlier.length ? [
      'Earlier Works for this Item, newest first (at most 3). Read a Task or Artifact by its ID for the details. If an earlier Work left a change, you may start from its commit instead of from scratch, and fix what its failed check names:',
      ...earlier,
    ] : ['No earlier Work for this Item.']),
    '',
  ].join('\n')
}
