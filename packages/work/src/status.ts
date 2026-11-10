/**
 * The status of a project (Item df-3): the Items of a repository's `STATUS.md`
 * (done as it says on the `origin/dev` tip, else `dev`) and the Works that carry them out.
 * Nothing here is stored.
 */
import { realpathSync } from 'node:fs'
import { git, snapshot } from './git.ts'
import { ITEM_ID } from './kinds.ts'
import type { LiveAttempt } from './live.ts'
import type { Claim, WorkEvent, WorkRecord } from './record.ts'

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
  /** The tip it was read at. */
  commit: string
  /** The ref it was read from: `origin/dev` when the repository has it, else `dev`. */
  ref: 'origin/dev' | 'dev'
  /** One line saying which ref was read and, if git can tell, how old it is (never fetched here). */
  note: string
}

/** When the remote-tracking ref was last updated (its newest reflog entry), if git has that. */
async function refAge(repository: string, ref: string): Promise<string | undefined> {
  try {
    const at = (await git(repository, ['log', '-g', '-1', '--format=%cI', `refs/remotes/${ref}`])).trim()
    const ms = Date.now() - Date.parse(at)
    if (!at || Number.isNaN(ms)) return undefined
    const hours = Math.max(0, Math.floor(ms / 3_600_000))
    return `updated ${hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`} ago, ${at}`
  } catch { return undefined }
}

/**
 * `STATUS.md` at the tip of `origin/dev` when the repository that contains
 * `path` has that remote-tracking ref, else of the local `dev`; read from git
 * and never from the working tree. It does not fetch: the note says how old
 * the ref is, when git can tell.
 */
export async function readStatus(path: string): Promise<StatusFile> {
  const top = realpathSync((await git(path, ['rev-parse', '--show-toplevel'])).trim())
  const remote = await git(top, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/dev^{commit}']).then(() => true, () => false)
  const ref = remote ? 'origin/dev' : 'dev'
  const { repository, commit } = await snapshot(top, remote ? 'refs/remotes/origin/dev' : 'dev')
  const age = remote ? await refAge(repository, ref) : undefined
  const note = `read ${ref} (${commit.slice(0, 12)})${remote ? `, not fetched: ${age ?? 'age unknown'}` : ', no origin/dev here'}`
  let text: string | undefined
  try {
    text = await git(repository, ['show', `${commit}:STATUS.md`])
  } catch { /* none at that commit */ }
  const parsed = text === undefined ? { aim: [], items: [], problems: [`no STATUS.md on ${ref} (${commit.slice(0, 12)}) in ${repository}`] } : parseStatus(text)
  return { repository, commit, ref, note, ...parsed }
}

type Admitted = Extract<WorkEvent, { type: 'admitted' }>
export type ItemRef = NonNullable<Admitted['item']>

const itemOf = (record: WorkRecord): ItemRef | undefined => (record.events[0]!.type === 'admitted' ? (record.events[0] as Admitted).item : undefined)
const admittedAt = (record: WorkRecord): string => record.events[0]!.at
/** A Work's status for people: `admitted, not running` when it was admitted and nothing has been done for it yet (its record is only its admission). */
export const workStatus = (record: WorkRecord): string => (record.state.status === 'running' && record.events.length === 1 ? 'admitted, not running' : record.state.status)

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
  if (attempt?.waiting) return `waiting for ${attempt.waiting}${attempt.until ? ` (until ${attempt.until})` : ''}`
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
  const idle = workStatus(record) === 'admitted, not running'
  const who = step ? `step ${step} on ${account}` : idle ? 'admitted, not running' : 'no step yet'
  const tail = record.state.status === 'held' ? `held: ${record.state.reason ?? 'no reason recorded'}` : live && !idle ? progressText(live(record.id).find((a) => a.stepId === step && (!!a.waiting || !waiting))) : ''
  return `${record.id} ${who} since ${admittedAt(record)}${tail ? `; ${tail}` : ''}`
}

/** Whether a Work's effects merged its change into `dev`: a `git.publish` the merge queue applied (it merges only into a base in `mergeInto`). */
const mergedEffect = (record: WorkRecord) => Object.values(record.state.effects).find((e) => e.state === 'applied' && e.detail?.merged === 'true')
export const wasMerged = (record: WorkRecord): boolean => !!mergedEffect(record)

/** The commit on `dev` a merged Work made, when its merge effect recorded it. */
export const mergeCommitOf = (record: WorkRecord): string | undefined => mergedEffect(record)?.detail?.mergeCommit

/** Whether a Work changed nothing: it did not succeed and a step of it failed on `no change` (a `code-write` tree equal to its base). */
const changedNothing = (record: WorkRecord): boolean =>
  record.state.status !== 'succeeded' && record.events.some((e) => e.type === 'observed' && e.status === 'failed' && /^no change\b/.test(e.reason ?? ''))

const artifactsOf = (record: WorkRecord): string[] => Object.values(record.state.results)

/**
 * One line per Item, as `[x] <id> <title> - <state>`: `done` (ticked in
 * STATUS.md, or a Work for it was merged into `dev`; with the last merged or
 * succeeded Work and its Artifacts, when there is one), `doing` (each Work
 * running or held: which step, on which Account, since when, and the progress
 * the Host holds for it, or why it is held; or a session's claim: who, since when) or `todo: nobody`. An Item only
 * the Works name is shown as not in STATUS.md. Without `live`, no progress. A done Item whose last merged Work's merge commit `released` says is not in the running release reads `done, not yet released`.
 */
export function itemLines(
  status: Pick<ParsedStatus, 'items'>, repository: string | undefined, records: WorkRecord[],
  live?: (workId: string) => LiveAttempt[], filter: { state?: 'todo' | 'doing' | 'done'; item?: string } = {}, claims: Claim[] = [],
  released?: (mergeCommit: string) => boolean | undefined,
): string[] {
  const listed = new Set(status.items.map((i) => i.id))
  const named = [...records.flatMap((r) => (itemOf(r)?.repository === repository && isActive(r) ? [itemOf(r)!.id] : [])), ...claims.filter((c) => c.repository === repository).map((c) => c.item)]
  const unlisted = [...new Set([...named, ...(filter.item ? [filter.item] : [])])].filter((id) => !listed.has(id))
  const lines: string[] = []
  for (const item of [...status.items.map((i) => ({ ...i, listed: true })), ...unlisted.map((id) => ({ id, title: '', done: false, listed: false }))]) {
    if (filter.item && item.id !== filter.item) continue
    const works = worksFor(records, { id: item.id, repository })
    const active = works.filter(isActive)
    // Done is derived: ticked by hand (done outside System) or a Work for the Item was merged into `dev`.
    const merged = works.filter(wasMerged)
    const claim = claims.find((c) => c.item === item.id && c.repository === repository)
    const state = item.done || merged.length ? 'done' : active.length || claim ? 'doing' : 'todo'
    if (filter.state && filter.state !== state) continue
    const last = merged.at(-1) ?? works.findLast((r) => r.state.status === 'succeeded')
    const text = state === 'done'
      ? `done${merged.length && released?.(mergeCommitOf(merged.at(-1)!) ?? '') === false ? ', not yet released' : ''}${last ? `; last ${[last.id, ...artifactsOf(last)].join(', ')}` : ''}`
      : state === 'doing' ? `doing: ${[...active.map((r) => doing(r, live)), ...(claim ? [`claimed by ${claim.who} since ${claim.at}`] : [])].join(' | ')}` : 'todo: nobody'
    lines.push(`${item.listed ? `[${state === 'done' ? 'x' : ' '}] ${item.id} ${item.title}` : `${item.id} (not in STATUS.md)`} - ${text}`)
  }
  return lines
}

/** The most recent earlier Works a Worker is told of in detail. */
const MAX_EARLIER = 3

/** One earlier Work as text with IDs: end status and reason, its Task, its changes and commits, and each failed verdict in full. */
function earlierText(r: WorkRecord, commitOf: ((id: string) => string | undefined) | undefined): string[] {
  const reason = r.state.status === 'running' ? `at step ${whoHas(r).step ?? 'none yet'}` : r.state.status === 'succeeded' ? artifactsOf(r).join(', ') : r.state.reason
  const lines = [`- ${r.id} ${r.state.status}${reason ? `: ${reason}` : ''}`]
  if (changedNothing(r)) lines.push('  changed nothing: no change to start from; its Task is the only thing to learn from')
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
    itemLines(status ?? { items: [] }, item.repository, records, undefined, { item: item.id })[0]!,
    `(Item ${item.id}${item.repository ? ` of ${item.repository}` : ''}, from STATUS.md on dev; done once a Work for it is merged into dev; a Work never ticks or edits its Item line in STATUS.md.)`,
    '',
    ...(earlier.length ? [
      'Earlier Works for this Item, newest first (at most 3). Read a Task or Artifact by its ID for the details. If an earlier Work left a change, you may start from its commit instead of from scratch, and fix what its failed check names:',
      ...earlier,
    ] : ['No earlier Work for this Item.']),
    '',
  ].join('\n')
}
