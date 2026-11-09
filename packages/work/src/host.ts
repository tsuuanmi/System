/**
 * The Host core (PROP-0004 C1, C2, C8, C11): the one process that owns every
 * Work of a home. It takes the Host lock, owns the `WorkController`, and runs
 * each Work-changing operation through one commit lane. A command's
 * `commandId` receipt is written with the event it caused, so a repeat is
 * answered from the record, also after a restart. On start, a Work with an
 * attempt that never reported has it marked `attempt-lost` and stays
 * interrupted until an explicit `run` or `retry`.
 */
import { createHash } from 'node:crypto'
import { hashDomain } from '@system/artifacts'
import type { CancelRequest } from './control.ts'
import { WorkController, type Admission, type Command, type Approval, type RetryOptions, type SpecStore, type WorkTable } from './controller.ts'
import { WorkError } from './errors.ts'
import { acquireHostLock, type HostLock } from './host-lock.ts'
import { commitLane, type Lane } from './lane.ts'
import type { Capabilities } from './registry.ts'
import { Slots } from './slots.ts'
import { TERMINAL, type WorkRecord } from './record.ts'

export interface HostOptions {
  /** `DSH_HOME`: the Host lock is named after its canonical path. */
  home: string
  table: WorkTable
  specs: SpecStore
  capabilities: Capabilities
  /** How long a running attempt may be quiet before it is reported stalled; default `DEFAULT_STALL_MINUTES`. */
  stallMinutes?: number
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
  /** Reads, `onChange`, `drain` and `held`: not `run`, `cancel` or `decide`, which only the commit lane and `commandId` may reach. */
  readonly view: Pick<WorkController, 'get' | 'list' | 'live' | 'replay' | 'onChange' | 'drain' | 'held'>
  private readonly lock: HostLock
  private readonly lane: Lane
  /**
   * The Accounts' slots. Worker attempts lost at start, whose process may
   * still run, keep theirs: `slots.uncertain()` lists them, and
   * `slots.settle()` frees those whose process is confirmed gone.
   */
  readonly slots: Slots
  private readonly commands = new Map<string, Seen>()
  private closed = false
  /** The Works that had an attempt marked lost when this Host started: nothing resumes them. */
  private readonly lostAtStart = new Set<string>()

  private constructor(lock: HostLock, options: HostOptions) {
    this.lock = lock
    const sequence = commitLane()
    // A closed Host writes nothing more, even for an attempt that was still running.
    this.lane = (section) => sequence(async () => {
      if (this.closed) throw new WorkError(`the Host is closed (it ran ${this.lock.home})`)
      return section()
    })
    this.slots = new Slots(options.capabilities)
    this.controller = new WorkController(options.table, options.specs, options.capabilities, this.lane, this.slots, options.stallMinutes)
    this.view = this.controller
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
      if ((await this.lane(() => this.controller.interrupt(record.id))).length) this.lostAtStart.add(record.id)
    }
    // Those whose process is already gone free their slot now; the rest stay held.
    await this.slots.settle()
  }

  /** Stop: refuse every further operation and free the home. Whatever was cut short is the next start's recovery. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.lock.release()
  }

  /**
   * Run the Works a draining Host held, and return the ones started. A Work that had an attempt lost at this
   * start, one that is finished or one already driven is left alone: nothing interrupted resumes by itself.
   */
  resume(workIds: string[]): string[] {
    const started = workIds.filter((id) => {
      const record = this.controller.get(id)
      return record && !TERMINAL.has(record.state.status) && !this.lostAtStart.has(id) && !this.controller.runningElsewhere(id)
    })
    for (const id of started) this.run(id).catch(() => {})
    return started
  }

  /** Admit a Work. With a `commandId` its ID derives from it, and the same submit again returns that Work. */
  submit(admission: Admission, options: Idempotent = {}): Promise<WorkRecord> {
    const workId = options.commandId ? workIdOf(options.commandId) : undefined
    return this.once({ commandId: options.commandId, op: 'submit', args: admission }, (command) => this.lane(() => this.controller.admit(admission, { workId, command })))
  }

  run(workId: string, options: Starting = {}): Promise<WorkRecord> {
    return this.once({ commandId: options.commandId, op: 'run', args: { workId }, started: options.started }, (command, started) => this.controller.run(workId, command, started))
  }

  retry(workId: string, options: Starting & RetryOptions): Promise<WorkRecord> {
    const { commandId, started, ...retry } = options
    return this.once({ commandId, op: 'retry', args: { workId, ...retry }, started }, (command, begun) => this.controller.retry(workId, retry, command, begun))
  }

  cancel(workId: string, options: Idempotent & CancelRequest): Promise<'requested' | WorkRecord> {
    const { commandId, ...request } = options
    return this.once({ commandId, op: 'cancel', args: { workId, ...request } }, (command) => this.controller.cancel(workId, request, command))
  }

  decide(workId: string, options: Starting & Approval): Promise<WorkRecord> {
    const { commandId, started, ...decision } = options
    return this.once({ commandId, op: 'decide', args: { workId, ...decision }, started }, (command, begun) => this.controller.decide(workId, decision, command, begun))
  }

  /**
   * Do `act` once per `commandId`: a repeat joins or replays it, and different
   * arguments are refused. `started` is called when `act` says it has begun
   * driving its Work, and for a repeat when the first call had.
   */
  private once<T>(command: { commandId?: string; op: string; args: unknown; started?: () => void }, act: (command: Command | undefined, started: () => void) => Promise<T>): Promise<T> {
    const { commandId, op, args, started } = command
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
