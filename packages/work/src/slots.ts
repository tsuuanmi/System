/**
 * The Account slots of the scheduler (PROP-0004 C3): a Worker's `ref` is an
 * Account with `maxConcurrentAttempts` slots (default 1). A lost attempt may
 * still run, so it keeps its slot until `settle` finds its process gone.
 */
import type { Capabilities, WorkerPort } from './registry.ts'

/** An attempt that was dispatched and never observed. */
export interface LostAttempt {
  workId: string
  stepId: string
  attemptId: string
}

export class Slots {
  private readonly capabilities: Capabilities
  /** Account -> the attempts holding one of its slots. */
  private readonly held = new Map<string, Set<string>>()
  /** Lost attempts whose process may still run, by attempt ID: they keep their slot until settled. */
  private readonly lost = new Map<string, { account: string; attempt: LostAttempt }>()
  private freed: () => void = () => {}

  constructor(capabilities: Capabilities) {
    this.capabilities = capabilities
  }

  /** Call `fn` whenever a slot is freed. */
  onFree(fn: () => void): void {
    this.freed = fn
  }

  /** Take a slot of the Worker's Account, if one is free. */
  reserve(worker: WorkerPort, attemptId: string): boolean {
    const held = this.held.get(worker.ref) ?? new Set<string>()
    if (held.size >= (worker.maxConcurrentAttempts ?? 1)) return false
    this.held.set(worker.ref, held.add(attemptId))
    return true
  }

  release(account: string, attemptId: string): void {
    if (this.held.get(account)?.delete(attemptId)) this.freed()
  }

  /** Keep `account`'s slot for a lost attempt until it is settled. */
  hold(account: string, attempt: LostAttempt): void {
    this.held.set(account, (this.held.get(account) ?? new Set()).add(attempt.attemptId))
    this.lost.set(attempt.attemptId, { account, attempt })
  }

  /** The lost attempts whose slots are held, in the order they were marked. */
  uncertain(): LostAttempt[] {
    return [...this.lost.values()].map((u) => u.attempt)
  }

  /** Ask each Worker whether the process of a lost attempt is confirmed gone; those that are free their slot. Returns them. */
  async settle(): Promise<LostAttempt[]> {
    const settled: LostAttempt[] = []
    for (const [attemptId, { account, attempt }] of [...this.lost]) {
      let gone = false
      try {
        gone = (await this.capabilities.workerFor(account)?.gone?.(attemptId)) ?? false
      } catch {
        gone = false
      }
      if (!gone) continue
      this.lost.delete(attemptId)
      this.release(account, attemptId)
      settled.push(attempt)
    }
    return settled
  }
}
