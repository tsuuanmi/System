/**
 * In-memory control of Work for the Host, the one process that owns every Work
 * ([the Host](../../../docs/architecture/host.md)): which Works are being run,
 * and the cancel request a running Work polls.
 */
import type { Caller } from './record.ts'
import { WorkError } from './errors.ts'

export interface CancelRequest {
  reason: string
  caller: Caller
}

export class MemoryControl {
  private readonly held = new Set<string>()
  private readonly cancels = new Map<string, CancelRequest>()

  /** Take the Work's lock; throws when it is already being run. Returns the release. */
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
