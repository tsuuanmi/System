/**
 * The Account slots of the scheduler (PROP-0004 C3): a Worker's `ref` is an
 * Account with `maxConcurrentAttempts` slots (default 1). A lost attempt may
 * still run, so it keeps its slot until `settle` finds its process gone.
 *
 * The same slots limit a verifier's concurrent runs (df-14): a verifier with
 * `maxConcurrentChecks` is an account named `check:<ref>` with that many slots.
 */
import type { Capabilities, VerifierPort, WorkerPort } from './registry.ts'

const CHECK = 'check:'

/** The account of a verifier's check slots. */
export const checkAccount = (verifier: Pick<VerifierPort, 'ref'>): string => `${CHECK}${verifier.ref}`

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
  /** Callers of `withCheck` waiting for a slot of an account, in order. */
  private readonly waiters = new Map<string, Array<{ limit: number; attemptId: string; go: () => void }>>()
  private freed: () => void = () => {}

  constructor(capabilities: Capabilities) {
    this.capabilities = capabilities
  }

  /** Call `fn` whenever a slot is freed. */
  onFree(fn: () => void): void {
    this.freed = fn
  }

  /** Whether the Worker's Account has a free slot. */
  hasFree(worker: WorkerPort): boolean {
    return (this.held.get(worker.ref)?.size ?? 0) < (worker.maxConcurrentAttempts ?? 1)
  }

  /** Take a slot of the Worker's Account, if one is free. */
  reserve(worker: WorkerPort, attemptId: string): boolean {
    return this.take(worker.ref, worker.maxConcurrentAttempts ?? 1, attemptId)
  }

  /** Take a check slot of the verifier, if one is free; always, when it sets no `maxConcurrentChecks`. */
  reserveCheck(verifier: VerifierPort, attemptId: string): boolean {
    return verifier.maxConcurrentChecks === undefined || this.take(checkAccount(verifier), verifier.maxConcurrentChecks, attemptId)
  }

  /**
   * Run `fn` holding a check slot of the verifier, waiting for one when all are taken (waiting is not a failure);
   * the slot is released when `fn` returns or throws. Runs at once when the verifier sets no `maxConcurrentChecks`.
   */
  async withCheck<T>(verifier: VerifierPort, attemptId: string, fn: () => Promise<T>): Promise<T> {
    const limit = verifier.maxConcurrentChecks
    if (limit === undefined) return fn()
    const account = checkAccount(verifier)
    const queue = this.waiters.get(account) ?? []
    if (queue.length || !this.take(account, limit, attemptId)) {
      await new Promise<void>((go) => { this.waiters.set(account, [...queue, { limit, attemptId, go }]) })
    }
    try {
      return await fn()
    } finally {
      this.release(account, attemptId)
    }
  }

  private take(account: string, limit: number, attemptId: string): boolean {
    const held = this.held.get(account) ?? new Set<string>()
    if (held.size >= limit) return false
    this.held.set(account, held.add(attemptId))
    return true
  }

  release(account: string, attemptId: string): void {
    if (!this.held.get(account)?.delete(attemptId)) return
    const queue = this.waiters.get(account) ?? []
    while (queue.length && this.take(account, queue[0]!.limit, queue[0]!.attemptId)) queue.shift()!.go()
    if (queue.length) this.waiters.set(account, queue)
    else this.waiters.delete(account)
    this.freed()
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

  /** Ask each Worker whether the process of a lost attempt is confirmed gone, or ends it when it is alive and verified as the attempt's own; those that are gone free their slot. Returns them. */
  async settle(): Promise<LostAttempt[]> {
    const settled: LostAttempt[] = []
    for (const [attemptId, { account, attempt }] of [...this.lost]) {
      let gone = false
      try {
        const owner = account.startsWith(CHECK) ? this.capabilities.verifierFor(account.slice(CHECK.length)) : this.capabilities.workerFor(account)
        gone = (await owner?.gone?.(attemptId)) ?? false
        // Alive and verified as the attempt's own process: a restart ended it, so end it and re-run its step.
        if (!gone && owner && 'end' in owner) gone = (await owner.end?.(attemptId)) ?? false
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
