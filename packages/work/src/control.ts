/**
 * Cross-process control of Work: the `HostControl` seam and `FileControl` over
 * files under `$DSH_HOME/system/control`
 * (one lock file per Work holding the running host's `<pid> <start time>`, published
 * atomically with it already in it, a dead or reused pid's lock stale, removed
 * only under a `<work>.takeover` mutex; one cancel
 * file per Work a running host polls; one JSON file per Work holding the
 * host and time of the last write, noted before and after it).
 */
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Caller } from './record.ts'
import { WorkError } from './errors.ts'

/**
 * Cross-process control of one Work (one DSH host per Work at a time). Each
 * host caches records in memory, so only the host that holds a Work's lock
 * writes it; another process asks it to cancel through `requestCancel`.
 */
export interface HostControl {
  /** Take the Work's lock; throws when a live host already runs it. Returns the release. */
  acquire(workId: string): () => void
  /** Whether a live run holds the Work's lock: another process, or another call in this one. */
  heldElsewhere(workId: string): boolean
  requestCancel(workId: string, request: CancelRequest): void
  cancelRequest(workId: string): CancelRequest | undefined
  clearCancel(workId: string): void
  /** The last write a lock holder noted for the Work: which host, and when (undefined if never noted). */
  lastWrite(workId: string): WriteMark | undefined
  /** Note, while holding the lock, that `write.host` is writing the Work at `write.at`. */
  noteWrite(workId: string, write: WriteMark): void
}

/** A host's write to a Work: the host's identity and the wall-clock time in ms. */
export interface WriteMark {
  host: string
  at: number
}

export interface CancelRequest {
  reason: string
  caller: Caller
}

/** How long a lock without a pid counts as one still being published (earlier versions wrote the pid after creating the file). */
const PUBLISHING_MS = 10_000

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A process's start time (field 22 of `/proc/<pid>/stat`), or '' when /proc has none. */
function startOf(pid: number): string {
  try {
    // The command name (field 2) may hold spaces and parentheses: count fields after its closing one.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? ''
  } catch {
    return ''
  }
}

/** The holder token of a process: `<pid> <start>`. */
function tokenOf(pid: number): string {
  return `${pid} ${startOf(pid)}`
}

/**
 * The live pid holding a lock file, if any. A file with no pid yet that is
 * recent counts as held (pid 0: being published); an old one is stale. A pid
 * is live only if the process exists and, when both the token and /proc have
 * a start time, they match (a dead pid reused by another process is stale).
 */
function holderOf(file: string): number | undefined {
  try {
    const text = readFileSync(file, 'utf8')
    if (!text.trim()) return Date.now() - statSync(file).mtimeMs < PUBLISHING_MS ? 0 : undefined
    const [pidText, start] = text.trim().split(/\s+/)
    const pid = Number(pidText)
    if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined
    const now = startOf(pid)
    return start && now && start !== now ? undefined : pid
  } catch {
    return undefined
  }
}

/** Publish a file holding this process's token by linking a complete draft to `path`; false if `path` exists. */
function publish(path: string): boolean {
  const draft = `${path}.${process.pid}.new`
  writeFileSync(draft, tokenOf(process.pid), { mode: 0o600 })
  try {
    linkSync(draft, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(draft, { force: true })
  }
}

/** Remove `path` if it holds this process's token. */
function unpublish(path: string): void {
  try {
    if (readFileSync(path, 'utf8').trim() === tokenOf(process.pid)) rmSync(path, { force: true })
  } catch {
    // already gone
  }
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** `HostControl` over files: see the module comment. */
export class FileControl implements HostControl {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  private file(workId: string, ext: string): string {
    return join(this.dir, `${workId.replace(/[^a-z0-9-]/gi, '_')}.${ext}`)
  }

  private holder(workId: string): number | undefined {
    return holderOf(this.file(workId, 'lock'))
  }

  acquire(workId: string): () => void {
    const lock = this.file(workId, 'lock')
    const holder = this.holder(workId)
    if (holder === 0) throw new WorkError(`${workId} is being run by another process`)
    if (holder !== undefined && holder !== process.pid) throw new WorkError(`${workId} is being run by process ${holder}; cancel it with \`system work cancel\``)
    if (holder === undefined && existsSync(lock)) this.takeStale(workId, lock)
    // Publish the lock with its token already in it: a link to a complete file
    // appears atomically and fails if a lock exists, so no host sees it empty.
    if (!publish(lock)) throw new WorkError(`${workId} is being run by another process`)
    return () => unpublish(lock)
  }

  /** Called while holding the takeover mutex, before the lock is read again. */
  protected beforeRecheck(_lock: string): void {}

  /**
   * Remove a stale lock without ever removing a live one: hold the takeover
   * mutex (`<work>.takeover`, published like the lock), read the lock again
   * and unlink it only if it is still stale. A fresh acquire never takes the mutex.
   */
  private takeStale(workId: string, lock: string): void {
    const mutex = lock.replace(/\.lock$/, '.takeover')
    if (!publish(mutex)) {
      // A mutex left by a crashed host (dead holder, older than PUBLISHING_MS) is removed once.
      const leftover = holderOf(mutex) === undefined && Date.now() - mtimeOf(mutex) > PUBLISHING_MS
      if (!leftover) throw new WorkError(`${workId} is being run by another process`)
      rmSync(mutex, { force: true })
      if (!publish(mutex)) throw new WorkError(`${workId} is being run by another process`)
    }
    try {
      this.beforeRecheck(lock)
      const pid = holderOf(lock)
      if (pid !== undefined) throw new WorkError(pid ? `${workId} is being run by process ${pid}` : `${workId} is being run by another process`)
      rmSync(lock, { force: true })
    } finally {
      unpublish(mutex)
    }
  }

  heldElsewhere(workId: string): boolean {
    // This process's own live lock is a concurrent run too: ask it to cancel.
    return this.holder(workId) !== undefined
  }

  requestCancel(workId: string, request: CancelRequest): void {
    const fd = openSync(this.file(workId, 'cancel'), 'w', 0o600)
    writeSync(fd, JSON.stringify(request))
    closeSync(fd)
  }

  cancelRequest(workId: string): CancelRequest | undefined {
    const file = this.file(workId, 'cancel')
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as CancelRequest
    } catch {
      return undefined
    }
  }

  clearCancel(workId: string): void {
    rmSync(this.file(workId, 'cancel'), { force: true })
  }

  lastWrite(workId: string): WriteMark | undefined {
    try {
      const mark = JSON.parse(readFileSync(this.file(workId, 'written'), 'utf8')) as Partial<WriteMark> | null
      return typeof mark?.host === 'string' && typeof mark.at === 'number' && Number.isFinite(mark.at) ? { host: mark.host, at: mark.at } : undefined
    } catch {
      return undefined
    }
  }

  noteWrite(workId: string, write: WriteMark): void {
    const file = this.file(workId, 'written')
    const draft = `${file}.${process.pid}.new`
    writeFileSync(draft, JSON.stringify(write), { mode: 0o600 })
    renameSync(draft, file)
  }
}
