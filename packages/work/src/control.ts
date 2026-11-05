/**
 * `HostControl` over files under `$DSH_HOME/system/control`: one lock file per
 * Work holding the running host's pid (created exclusively; a dead pid's lock
 * is stale), and one cancel file per Work a running host polls.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { WorkError, type CancelRequest, type HostControl } from './controller.ts'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

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
