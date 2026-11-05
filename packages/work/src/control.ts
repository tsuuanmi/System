/**
 * Cross-process control of Work: the `HostControl` seam, `LocalControl` for a
 * single process, and `FileControl` over files under `$DSH_HOME/system/control`
 * (one lock file per Work holding the running host's pid, created exclusively,
 * a dead pid's lock stale; one cancel file per Work a running host polls).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
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

/** For a single process (tests): no other host exists. */
export class LocalControl implements HostControl {
  private readonly held = new Set<string>()
  private readonly cancels = new Map<string, CancelRequest>()

  acquire(workId: string): () => void {
    if (this.held.has(workId)) throw new WorkError(`${workId} is already being run`)
    this.held.add(workId)
    return () => { this.held.delete(workId) }
  }

  heldElsewhere(workId: string): boolean {
    return this.held.has(workId)
  }

  requestCancel(workId: string, request: CancelRequest): void {
    this.cancels.set(workId, request)
  }

  cancelRequest(workId: string): CancelRequest | undefined {
    return this.cancels.get(workId)
  }

  clearCancel(workId: string): void {
    this.cancels.delete(workId)
  }
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
    if (holder === undefined) rmSync(lock, { force: true })
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
