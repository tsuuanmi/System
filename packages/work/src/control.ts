/**
 * Cross-process control of Work: the `HostControl` seam and `FileControl` over
 * files under `$DSH_HOME/system/control`
 * (one lock file per Work holding the running host's pid, published
 * atomically with its pid already in it, a dead pid's lock stale; one cancel
 * file per Work a running host polls; one count file per Work holding how
 * many events the last lock holder wrote).
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
  /** How many events the Work had when a lock holder last wrote it (0 if never noted). */
  written(workId: string): number
  /** Note, while holding the lock, how many events the Work now has. */
  noteWritten(workId: string, events: number): void
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

/**
 * The live pid holding a lock file, if any. A file with no pid yet that is
 * recent counts as held (pid 0: being published); an old one is stale.
 */
function holderOf(file: string): number | undefined {
  try {
    const text = readFileSync(file, 'utf8')
    if (!text.trim()) return Date.now() - statSync(file).mtimeMs < PUBLISHING_MS ? 0 : undefined
    const pid = Number(text)
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined
  } catch {
    return undefined
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
    // Publish the lock with the pid already in it: a link to a complete file
    // appears atomically and fails if a lock exists, so no host sees it empty.
    const draft = `${lock}.${process.pid}.new`
    writeFileSync(draft, String(process.pid), { mode: 0o600 })
    try {
      linkSync(draft, lock)
    } catch {
      throw new WorkError(`${workId} is being run by another process`)
    } finally {
      rmSync(draft, { force: true })
    }
    return () => { if (this.holder(workId) === process.pid) rmSync(lock, { force: true }) }
  }

  /**
   * Remove a stale lock without ever removing a live one: move it aside
   * atomically, and if what was moved belongs to a live process (another host
   * replaced the stale lock first), put it back and refuse.
   */
  private takeStale(workId: string, lock: string): void {
    const aside = `${lock}.${process.pid}.stale`
    try {
      renameSync(lock, aside)
    } catch {
      return
    }
    const pid = holderOf(aside)
    if (pid !== undefined) {
      try {
        linkSync(aside, lock)
      } finally {
        rmSync(aside, { force: true })
      }
      throw new WorkError(pid ? `${workId} is being run by process ${pid}` : `${workId} is being run by another process`)
    }
    rmSync(aside, { force: true })
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

  written(workId: string): number {
    try {
      const count = Number(readFileSync(this.file(workId, 'written'), 'utf8'))
      return Number.isInteger(count) && count > 0 ? count : 0
    } catch {
      return 0
    }
  }

  noteWritten(workId: string, events: number): void {
    const file = this.file(workId, 'written')
    const draft = `${file}.${process.pid}.new`
    writeFileSync(draft, String(events), { mode: 0o600 })
    renameSync(draft, file)
  }
}
