/**
 * The Host core (PROP-0004 C1, C2, C8, C11): the one process that owns every
 * Work of a home, in-process (the socket is served by `packages/host`). It takes the Host
 * lock, owns the `WorkController`, and runs each Work-changing operation
 * through one commit lane, so two operations never interleave their decisions.
 * Attempts execute outside the lane and come back through it to be observed.
 *
 * A command may carry a `commandId`: its receipt is written into the Work it
 * changed, in the same update as the event it caused, so a repeat is answered
 * from the record, also after a restart. A refusal has no event to travel
 * with; it is remembered for as long as the Host runs.
 *
 * On start, before any operation, every Work with an attempt that never
 * reported has it marked `attempt-lost` and is left interrupted: nothing runs
 * again until an explicit `run` or `retry`.
 */
import { createHash } from 'node:crypto'
import { hashDomain } from '@system/artifacts'
import type { CancelRequest } from './control.ts'
import { WorkController, type Admission, type Command, type LostAttempt, type SpecStore, type WorkTable } from './controller.ts'
import { WorkError } from './errors.ts'
import type { GoalView } from './goal.ts'
import { acquireHostLock, type HostLock } from './host-lock.ts'
import { commitLane, type Lane } from './lane.ts'
import type { Capabilities } from './registry.ts'
import { TERMINAL, type Caller, type WorkRecord, type WorkState } from './record.ts'

export interface HostOptions {
  /** `DSH_HOME`: the Host lock is named after its canonical path. */
  home: string
  table: WorkTable
  specs: SpecStore
  capabilities: Capabilities
}

/** An option every command takes: with it, a repeat is answered, not done again. */
interface Idempotent {
  commandId?: string
}

/** What `run` and `retry` also take: a signal that the Work is held and about to be driven (not given when a repeat is answered from a receipt). */
interface Starting extends Idempotent {
  started?: () => void
}

/** A command seen: the hash of its arguments, its answer (a stored receipt answers with the Work as it is now), and whether it has begun driving its Work. */
interface Seen {
  args: string
  result: () => Promise<unknown>
  begun: Promise<void>
}

export class Host {
  private readonly controller: WorkController
  private readonly lock: HostLock
  private readonly lane: Lane
  private readonly commands = new Map<string, Seen>()
  private closed = false

  private constructor(lock: HostLock, options: HostOptions) {
    this.lock = lock
    const sequence = commitLane()
    // A closed Host writes nothing more, even for an attempt that was still running.
    this.lane = (section) => sequence(async () => {
      if (this.closed) throw new WorkError(`the Host is closed (it ran ${this.lock.home})`)
      return section()
    })
    this.controller = new WorkController(options.table, options.specs, options.capabilities, this.lane)
  }

  /** Take the lock for `options.home`, then recover, then accept operations. Refuses when another Host holds the home. */
  static async start(options: HostOptions): Promise<Host> {
    const lock = await acquireHostLock(options.home)
    try {
      const host = new Host(lock, options)
      await host.recover()
      return host
    } catch (error) {
      await lock.release()
      throw error
    }
  }

  private async recover(): Promise<void> {
    for (const record of this.controller.list()) {
      for (const receipt of record.receipts ?? []) {
        this.commands.set(receipt.commandId, { args: receipt.args, result: async () => this.controller.get(record.id), begun: Promise.resolve() })
      }
      if (TERMINAL.has(record.state.status)) continue
      await this.lane(() => this.controller.interrupt(record.id))
    }
    // Those whose process is already gone free their slot now; the rest stay held.
    await this.controller.settle()
  }

  /**
   * Worker attempts lost at start, whose process may still be running: each
   * keeps its Account's slot until `settle` finds it gone.
   */
  uncertain(): LostAttempt[] {
    return this.controller.uncertainAttempts()
  }

  /** Ask each Account's Worker whether a lost attempt's process is confirmed gone; those that are free their slot. Returns them. */
  settle(): Promise<LostAttempt[]> {
    return this.controller.settle()
  }

  /** Stop: refuse every further operation and free the home. Whatever was cut short is the next start's recovery. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.lock.release()
  }

  get(workId: string): WorkRecord | undefined {
    return this.controller.get(workId)
  }

  list(): WorkRecord[] {
    return this.controller.list()
  }

  replay(workId: string): { state: WorkState; matches: boolean } {
    return this.controller.replay(workId)
  }

  /** A Goal, its current version and its spend. Refuses an ID that is not a stored Goal. */
  goal(goalId: string): GoalView {
    return this.controller.goalView(goalId)
  }

  /** Works with work left to do and no run driving them: after a start, the interrupted ones. */
  interrupted(): string[] {
    return this.list().filter((r) => !TERMINAL.has(r.state.status) && !this.controller.runningElsewhere(r.id)).map((r) => r.id)
  }

  /** Admit a Work. With a `commandId` its ID derives from it, and the same submit again returns that Work. */
  submit(admission: Admission, options: Idempotent = {}): Promise<WorkRecord> {
    const workId = options.commandId ? workIdOf(options.commandId) : undefined
    return this.once(options.commandId, 'submit', admission, undefined, (command) => this.lane(() => this.controller.admit(admission, { workId, command })))
  }

  run(workId: string, options: Starting = {}): Promise<WorkRecord> {
    return this.once(options.commandId, 'run', { workId }, options.started, (command, started) => this.controller.run(workId, command, started))
  }

  retry(workId: string, options: Starting & { worker?: string; step?: string; caller: Caller; reason: string }): Promise<WorkRecord> {
    const { commandId, started, ...retry } = options
    return this.once(commandId, 'retry', { workId, ...retry }, started, (command, begin) => this.controller.retry(workId, retry, command, begin))
  }

  cancel(workId: string, options: Idempotent & CancelRequest): Promise<'requested' | WorkRecord> {
    const { commandId, ...request } = options
    return this.once(commandId, 'cancel', { workId, ...request }, undefined, (command) => this.controller.cancel(workId, request, command))
  }

  decide(workId: string, options: Starting & { decision: 'approved' | 'denied'; caller: Caller; reason: string }): Promise<WorkRecord> {
    const { commandId, started, ...decision } = options
    return this.once(commandId, 'decide', { workId, ...decision }, started, (command, begin) => this.controller.decide(workId, decision, command, begin))
  }

  /**
   * Do `act` once per `commandId`: a repeat joins or replays it, and different
   * arguments are refused. `started` is called when `act` says it has begun
   * driving its Work, and for a repeat when the first call had.
   */
  private once<T>(commandId: string | undefined, op: string, args: unknown, started: (() => void) | undefined, act: (command: Command | undefined, begin: () => void) => Promise<T>): Promise<T> {
    if (!commandId) return act(undefined, () => started?.())
    const hash = hashDomain('system.command/v1', { op, args })
    const seen = this.commands.get(commandId)
    if (seen) {
      if (seen.args !== hash) return Promise.reject(new WorkError(`commandId ${commandId} was used with different arguments; use a new commandId for a different command`))
      if (started) void seen.begun.then(started)
      return seen.result() as Promise<T>
    }
    let begin!: () => void
    const begun = new Promise<void>((resolve) => { begin = resolve })
    if (started) void begun.then(started)
    const result = act({ id: commandId, args: hash }, begin)
    this.commands.set(commandId, { args: hash, result: () => result, begun })
    return result
  }
}

/** A UUIDv5-style Work ID: the first 128 bits of a SHA-256 of the commandId, with the version and variant set. */
function workIdOf(commandId: string): string {
  const bytes = createHash('sha256').update(`system-work\n${commandId}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `work:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
