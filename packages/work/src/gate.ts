/**
 * The Item gate: the one place that answers "may this Item get a Task, a Claim or a Work?" (ADR-0012: an Item's
 * state is derived from STATUS.md and the Works, never stored; the Host never picks an Item). It reads STATUS.md
 * (git, behind `readStatus`, which a test replaces), derives Ready, Blocked, busy and claimed, owns the Claim
 * table, and words every refusal. Reading is async and happens before the commit lane; deciding is synchronous
 * and runs in the lane, so "busy" cannot race.
 */
import { realpathSync } from 'node:fs'
import { WorkError } from './errors.ts'
import { git, snapshot } from './git.ts'
import { parseStatus, type ParsedStatus } from './status-parse.ts'
import type { Caller, Claim, WorkRecord } from './record.ts'
import { activeWork, blockedText, itemBlockedBy, itemNote, whoHas, type ItemRef } from './status.ts'

/** The claims on Items: one key per Item of a repository (see `claimKey`). */
export interface ClaimTable {
  get(key: string): Claim | undefined
  put(key: string, value: Claim): Promise<void>
  delete(key: string): Promise<boolean>
  keys(): IterableIterator<string>
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

const claimKey = (repository: string, item: string): string => `${repository}\n${item}`

/** A claim table in memory, for a gate built without one. */
function memoryClaims(): ClaimTable {
  const rows = new Map<string, Claim>()
  return { get: (key) => rows.get(key), put: async (key, value) => { rows.set(key, value) }, delete: async (key) => rows.delete(key), keys: () => rows.keys() }
}

/** A STATUS.md read for an Item's repository: the file, or why there is none (never thrown, so the decision can word it). */
interface Reading { repository?: string; status?: StatusFile; error?: unknown }

/** What deciding an Item for a Work gives the controller: the note for its Task, and what to do once the Work's record is written. */
export interface Decision {
  note: string
  /** A Work for the Item takes over a session's Claim on it. */
  taken(): Promise<void>
}

/** The decision for one Item, made in the commit lane from a STATUS.md read before it; throws a `WorkError` to refuse. */
export type Decide = (item: ItemRef) => Decision

export interface GateOptions {
  /** The Works, as they are now. */
  records: () => WorkRecord[]
  claims?: ClaimTable
  /** Reads a repository's STATUS.md; default `readStatus` (git). */
  readStatus?: (path: string) => Promise<StatusFile>
  /** The commit of a stored change, for the note's earlier Works. */
  commitOf?: (id: string) => string | undefined
}

const unreadable = (repository: string, error: unknown): string =>
  `STATUS.md of ${repository} could not be read: ${(error as Error).message}; to go on without it, give force`
const noLine = (item: string, status: Pick<StatusFile, 'ref' | 'repository'>): string =>
  `Item ${item} has no line in STATUS.md on ${status.ref} of ${status.repository}; to go on without it, give force`

export class ItemGate {
  private readonly claimed: ClaimTable
  private readonly read: (path: string) => Promise<StatusFile>
  private readonly options: GateOptions

  constructor(options: GateOptions) {
    this.options = options
    this.claimed = options.claims ?? memoryClaims()
    this.read = options.readStatus ?? readStatus
  }

  private async reading(repository: string): Promise<Reading> {
    try { return { repository, status: await this.read(repository) } } catch (error) { return { repository, error } }
  }

  /** The line check for an Item of a repository: STATUS.md readable, a line for the Item, not Blocked. */
  private refuse(item: string, reading: Reading, blockedEnd: string): void {
    if (!reading.status) throw new WorkError(unreadable(reading.repository!, reading.error))
    const { status } = reading
    if (!status.items.some((i) => i.id === item)) throw new WorkError(noLine(item, status))
    const why = itemBlockedBy(status, status.repository, this.options.records(), item)
    if (why) throw new WorkError(`Item ${item} is ${blockedText(why)}; ${blockedEnd}`)
  }

  private busy(item: ItemRef): WorkRecord | undefined {
    return activeWork(this.options.records(), item)
  }

  /**
   * Before the lane: read the STATUS.md for an Item a Work is to be admitted for (async, git). Returns the decision to
   * run in the lane, or undefined when the Task names no Item.
   */
  async deciding(item: ItemRef | undefined, force?: boolean): Promise<Decide | undefined> {
    if (!item) return undefined
    const reading: Reading = item.repository ? await this.reading(item.repository) : {}
    return (named) => {
      if (!force) {
        const busy = this.busy(named)
        if (busy) throw new WorkError(`Item ${named.id} already has Work ${busy.id} (${busy.state.status}, ${whoHas(busy).account ?? 'no Worker yet'}); to run another on purpose, give force (--force)`)
        if (named.repository) this.refuse(named.id, reading, 'to run it on purpose, give force (--force)')
      }
      return {
        note: itemNote(named, this.options.records(), this.options.commitOf, reading.status),
        taken: async () => { if (named.repository) await this.claimed.delete(claimKey(named.repository, named.id)) },
      }
    }
  }

  /** `task.new`: refuse an Item of a repository that is Blocked, has no line or has no readable STATUS.md, unless `force`. */
  async checkTask(item: string | undefined, repository: string | undefined, force?: boolean): Promise<void> {
    if (!item || !repository || force) return
    this.refuse(item, await this.reading(repository), 'to store its Task on purpose, give force')
  }

  /** Before the lane, for `item.claim`: the repository as STATUS.md names it; refused without a line unless `force`. */
  async claimTarget(repository: string, item: string, force?: boolean): Promise<string> {
    const reading = await this.reading(repository)
    if (force) return reading.status?.repository ?? repository
    if (!reading.status) throw new WorkError(unreadable(repository, reading.error))
    if (!reading.status.items.some((i) => i.id === item)) throw new WorkError(noLine(item, reading.status))
    return reading.status.repository
  }

  /** The claims on Items, by session. */
  claims(): Claim[] {
    return [...this.claimed.keys()].map((key) => this.claimed.get(key)!)
  }

  /**
   * Claim an Item for `caller` before submitting a Work for it. Refused while a Work for the Item is running or held,
   * and while another caller holds the claim unless `force`. Call it in the commit lane.
   */
  async claim(repository: string, item: string, caller: Caller, force = false): Promise<Claim> {
    const busy = this.busy({ id: item, repository })
    if (busy) throw new WorkError(`Item ${item} already has Work ${busy.id} (${busy.state.status}, ${whoHas(busy).account ?? 'no Worker yet'})`)
    const held = this.claimed.get(claimKey(repository, item))
    if (held && held.who !== caller.operatorId && !force) throw new WorkError(`Item ${item} is claimed by ${held.who} since ${held.at}; to take it over on purpose, give force (--force)`)
    const claim: Claim = { repository, item, who: caller.operatorId, at: new Date().toISOString() }
    await this.claimed.put(claimKey(repository, item), claim)
    return claim
  }
}
