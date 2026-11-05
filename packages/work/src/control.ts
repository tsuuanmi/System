/**
 * Cross-process control of Work: the `HostControl` seam and `FileControl` over
 * files under `$DSH_HOME/system/control`
 * (one lock file per Work holding the running host's pid, created exclusively,
 * a dead pid's lock stale; one cancel file per Work a running host polls).
 */
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
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
}

export interface CancelRequest {
  reason: string
  caller: Caller
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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
    try {
      const pid = Number(readFileSync(this.file(workId, 'lock'), 'utf8'))
      return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined
    } catch {
      return undefined
    }
  }

  acquire(workId: string): () => void {
    const lock = this.file(workId, 'lock')
    const holder = this.holder(workId)
    if (holder !== undefined && holder !== process.pid) throw new WorkError(`${workId} is being run by process ${holder}; cancel it with \`system work cancel\``)
    if (holder === undefined && existsSync(lock)) this.takeStale(workId, lock)
    let fd: number
    try {
      fd = openSync(lock, 'wx', 0o600)
    } catch {
      throw new WorkError(`${workId} is being run by another process`)
    }
    writeSync(fd, String(process.pid))
    closeSync(fd)
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
    const pid = Number(readFileSync(aside, 'utf8'))
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      try {
        linkSync(aside, lock)
      } finally {
        rmSync(aside, { force: true })
      }
      throw new WorkError(`${workId} is being run by process ${pid}`)
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
}
