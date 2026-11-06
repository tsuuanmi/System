/**
 * The Host core (PROP-0004 C1, C2, C8, C11): the one process that owns every
 * Work of a home, in-process for now (the socket is H3). It takes the Host
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
import { MemoryControl } from './control.ts'
import { WorkController, type Admission, type Command, type HostIdentity, type LostAttempt, type SpecStore, type WorkTable } from './controller.ts'
import { WorkError } from './errors.ts'
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
  identity?: HostIdentity
}

/** An option every command takes: with it, a repeat is answered, not done again. */
interface Idempotent {
  commandId?: string
}

/** A command seen: the hash of its arguments, and its answer (a stored receipt answers with the Work as it is now). */
interface Seen {
  args: string
  result: () => Promise<unknown>
}

export class Host {
  private readonly controller: WorkController
  private readonly lock: HostLock
  private readonly lane: Lane
  private readonly commands = new Map<string, Seen>()
  private lost: LostAttempt[] = []
  private closed = false

  private constructor(lock: HostLock, options: HostOptions) {
    this.lock = lock
    const sequence = commitLane()
    // A closed Host writes nothing more, even for an attempt that was still running.
    this.lane = (section) => sequence(async () => {
      if (this.closed) throw new WorkError(`the Host is closed (it ran ${this.lock.home})`)
      return section()
    })
    this.controller = new WorkController(options.table, options.specs, options.capabilities, new MemoryControl(), options.identity, this.lane)
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
        this.commands.set(receipt.commandId, { args: receipt.args, result: async () => this.controller.get(record.id) })
      }
      if (TERMINAL.has(record.state.status)) continue
      this.lost.push(...await this.lane(() => this.controller.interrupt(record.id)))
    }
  }

  /**
   * Attempts lost at start, whose process may still be running. Today nothing
   * holds for them; with Account slots (H5) each keeps its slot until
   * reconciliation settles it.
   */
  uncertain(): LostAttempt[] {
    return [...this.lost]
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

  /** Works with work left to do and no run driving them: after a start, the interrupted ones. */
  interrupted(): string[] {
    return this.list().filter((r) => !TERMINAL.has(r.state.status) && !this.controller.runningElsewhere(r.id)).map((r) => r.id)
  }

  /** Admit a Work. With a `commandId` its ID derives from it, and the same submit again returns that Work. */
  submit(admission: Admission, options: Idempotent = {}): Promise<WorkRecord> {
    const workId = options.commandId ? workIdOf(options.commandId) : undefined
    return this.once(options.commandId, 'submit', admission, (command) => this.lane(() => this.controller.admit(admission, { workId, command })))
  }

  run(workId: string, options: Idempotent = {}): Promise<WorkRecord> {
    return this.once(options.commandId, 'run', { workId }, (command) => this.controller.run(workId, command))
  }

  retry(workId: string, options: Idempotent & { worker?: string; step?: string; caller: Caller; reason: string }): Promise<WorkRecord> {
    const { commandId, ...retry } = options
    return this.once(commandId, 'retry', { workId, ...retry }, (command) => this.controller.retry(workId, retry, command))
  }

  cancel(workId: string, options: Idempotent & CancelRequest): Promise<'requested' | WorkRecord> {
    const { commandId, ...request } = options
    return this.once(commandId, 'cancel', { workId, ...request }, (command) => this.controller.cancel(workId, request, command))
  }

  decide(workId: string, options: Idempotent & { decision: 'approved' | 'denied'; caller: Caller; reason: string }): Promise<WorkRecord> {
    const { commandId, ...decision } = options
    return this.once(commandId, 'decide', { workId, ...decision }, (command) => this.controller.decide(workId, decision, command))
  }

  /** Do `act` once per `commandId`: a repeat joins or replays it, and different arguments are refused. */
  private once<T>(commandId: string | undefined, op: string, args: unknown, act: (command?: Command) => Promise<T>): Promise<T> {
    if (!commandId) return act()
    const hash = hashDomain('system.command/v1', { op, args })
    const seen = this.commands.get(commandId)
    if (seen) {
      return seen.args === hash ? seen.result() as Promise<T> : Promise.reject(new WorkError(`commandId ${commandId} was used with different arguments; use a new commandId for a different command`))
    }
    const result = act({ id: commandId, args: hash })
    this.commands.set(commandId, { args: hash, result: () => result })
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
