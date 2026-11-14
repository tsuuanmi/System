/**
 * The Work Controller: one generic interpreter for every Workflow, with no
 * domain-specific branch (ADR-0002 decision 3; scheduling and recovery:
 * docs/architecture/host.md). Each attempt is three phases: dispatch and
 * observe run in the commit lane and read the latest committed record;
 * execute runs outside it and touches no Work state.
 */
import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from '@system/artifacts'
import { z } from 'zod'
import { WorkError } from './errors.ts'
import { noLane, type Lane } from './lane.ts'
import { isQuotaLimited } from './limits.ts'
import { DEFAULT_STALL_MINUTES, LiveAttempts, type LiveAttempt } from './live.ts'
import type { Task, Verdict } from './kinds.ts'
import { Slots, checkAccount, type LostAttempt } from './slots.ts'
import { activeWork, itemNote, whoHas } from './status.ts'
import type { QuotaReading } from './headroom.ts'
import type { Capabilities, EffectIntent, EffectOutcome, EffectPort, Reconciled, VerifierPort, VerifyResult, WorkerPort, WorkerResult } from './registry.ts'
import { TERMINAL, fold, workRecordSchema, type Caller, type Claim, type NewEvent, type Receipt, type WorkEvent, type WorkRecord, type WorkState } from './record.ts'
import { isEffectStep, isVerifyStep, isWorkerStep, stepSchema, type ResolvedSpec, type Step } from './workflow.ts'

/** The Work table: one key per Work, changed only by atomic `update`. */
export interface WorkTable {
  get(key: string): WorkRecord | undefined
  put(key: string, value: WorkRecord): Promise<void>
  update(key: string, fn: (current: WorkRecord) => WorkRecord): Promise<WorkRecord>
  keys(): IterableIterator<string>
}

/** The claims on Items: one key per Item of a repository (see `claimKey`). */
export interface ClaimTable {
  get(key: string): Claim | undefined
  put(key: string, value: Claim): Promise<void>
  delete(key: string): Promise<boolean>
  keys(): IterableIterator<string>
}

const claimKey = (repository: string, item: string): string => `${repository}\n${item}`

/** A claim table in memory, for a controller built without one. */
function memoryClaims(): ClaimTable {
  const rows = new Map<string, Claim>()
  return { get: (key) => rows.get(key), put: async (key, value) => { rows.set(key, value) }, delete: async (key) => rows.delete(key), keys: () => rows.keys() }
}

/** The Artifact operations the controller needs. */
export interface SpecStore {
  putSpec(spec: ResolvedSpec, caller: Caller): Promise<string>
  getSpec(specId: string): ResolvedSpec | undefined
  exists(id: string): boolean
  /** The kind of a stored Artifact. */
  kindOf(id: string): string | undefined
  /** The base commit of a stored `git-tree@1` Artifact whose tree is its base's own tree (a change that changes nothing); undefined otherwise. */
  unchangedBase(id: string): string | undefined
  /** The commit of a stored `git-tree@1` Artifact (a change); undefined for any other Artifact. */
  commitOf?(id: string): string | undefined
  /** Store a `verdict@1` Artifact; returns its ID. */
  putVerdict(verdict: Verdict): Promise<string>
  /** A stored Task, and the repository of its base commit; undefined when `id` is not a Task. */
  taskOf(id: string): { task: Task; repository?: string } | undefined
  /** Store a copy of Task `id` with `note` added to its context as a text Artifact; returns the copy's ID. */
  withNote(id: string, note: string, caller: Caller): Promise<string>
}

/** How often a running attempt checks for a cancel request. */
const CANCEL_POLL_MS = 250
/** A step waiting on quota is tried again at the earliest reset, or at least this often (a reading may have changed). */
const QUOTA_RETRY_MS = 5 * 60_000

export const SPEC_KIND = 'workflow-spec'
export const SPEC_SCHEMA_VERSION = 1

/** The zod schema of a resolved spec, for the `workflow-spec@1` Artifact kind. */
export const resolvedSpecSchema = z.object({
  workflow: z.object({ id: z.string(), version: z.number().int().positive() }).strict(),
  steps: z.array(stepSchema).min(1).max(32),
}).strict()

export interface Admission {
  spec: ResolvedSpec
  input?: string
  /** Only this Worker may take the Work's Worker steps; it must be enabled and offer each step's capabilities. */
  worker?: string
  /** Allow a Work for an Item that already has a running or held one. */
  force?: boolean
  caller: Caller
  source: { kind: 'workflow-file' | 'direct-task'; path?: string; fileHash?: string }
}

/** A command that is to leave a receipt in the Work it changes: its client ID and the hash of its arguments. */
export interface Command {
  id: string
  args: string
}

/** What `retry` is told: which step and Worker take over, by whom and why. */
export interface RetryOptions {
  worker?: string
  step?: string
  caller: Caller
  reason: string
}

/** A human's approval or denial of what held Work awaits (GLOSSARY: Approval). */
export interface Approval {
  decision: 'approved' | 'denied'
  caller: Caller
  reason: string
}

/** What one turn of a drive decided: the record now, and, for each attempt dispatched, how to finish it. */
interface Turn {
  record: WorkRecord
  /** Execute outside the lane, then observe in it. */
  settles: (() => Promise<WorkRecord>)[]
  /** Nothing more can be done until an attempt reports or a slot is freed. */
  waiting?: boolean
  /** The slot epoch the decision was made at: a change since means the wait is over. */
  epoch: number
}

/** A dispatched Worker attempt: what `execute` needs and `observe` reports on. */
interface WorkerAttempt {
  workId: string
  attemptId: string
  step: Extract<Step, { capabilities: string[] }>
  worker: WorkerPort
  inputs: Record<string, string>
}

/** What a Worker run produced, and whether a cancel request stopped it. */
interface WorkerExecution {
  result: WorkerResult
  aborted: boolean
}

/** A dispatched verifier attempt; `refusal` is why it is not asked at all. */
interface VerifierAttempt {
  workId: string
  attemptId: string
  step: Extract<Step, { verify: unknown }>
  verifier: VerifierPort
  subject: string
  criteria: string
  /** The step's further inputs, resolved. */
  inputs: Record<string, string>
  /** Evidence of this step's earlier verdicts against the same criteria that were not a pass, oldest first. */
  earlier: string[]
  refusal?: string
}

/** What a listener of `onChange` is told after an event is committed. */
export interface WorkChange {
  workId: string
  status: WorkState['status']
  /** The `seq` of the event just committed: 0 for an admission. */
  seq: number
  /** The event's type, or `stalled` when an attempt of the Work has been quiet for `stallMinutes` (no event). */
  type: WorkEvent['type'] | 'stalled'
}

export interface CancelRequest {
  reason: string
  caller: Caller
}

export class WorkController {
  private readonly table: WorkTable
  private readonly claimed: ClaimTable
  private readonly specs: SpecStore
  private readonly capabilities: Capabilities
  /** The Works being run, and the cancel request a running Work polls; the Host owns every Work, so both live in memory. */
  private readonly locked = new Set<string>()
  private readonly cancels = new Map<string, CancelRequest>()
  private readonly lane: Lane
  /** Commands whose receipt the next `terminal` event of a Work carries. */
  private readonly expected = new Map<string, Receipt[]>()
  readonly slots: Slots
  /** Changes whenever a slot is freed or a cancel is asked, so a waiting drive does not miss it. */
  private epoch = 0
  /** The drives waiting for such a change, by Work. */
  private readonly waiters = new Map<string, () => void>()
  private readonly listeners = new Set<(change: WorkChange) => void>()
  /** Set by `drain`: no further attempt is dispatched; a drive that would waits. */
  private draining = false
  /** The attempts dispatched and not yet reported, counted in the lane where they are dispatched. */
  private attempts = 0
  private readonly quiet = new Set<() => void>()
  /** The Works a drive is advancing now. */
  private readonly driving = new Set<string>()
  /** The Works whose verify step waits for a check slot, in memory only. */
  private readonly waitingForCheck = new Map<string, { stepId: string; verifier: string; since: number }>()
  /** When each Worker step (`<work>/<step>`) first found every capable Account full, in memory only. */
  private readonly waitingForSlot = new Map<string, number>()
  /** The Worker steps (`<work>/<step>`) whose capable, free Accounts are all over the quota ceiling, in memory only; `timer` tries them again. */
  private readonly waitingForQuota = new Map<string, { workId: string; stepId: string; worker: string; since: number; until?: string; timer: NodeJS.Timeout }>()
  /** The running Worker attempts' progress, in memory only. */
  private readonly running: LiveAttempts
  private readonly quotaRetryMs: number
  /** Accounts that just limited an attempt (ref -> passed over until). In memory only: after a restart the quota is read fresh and routing is as usual. */
  private readonly limitedAccounts = new Map<string, number>()

  constructor(table: WorkTable, specs: SpecStore, capabilities: Capabilities, lane: Lane = noLane, slots: Slots = new Slots(capabilities), stallMinutes = DEFAULT_STALL_MINUTES, claims: ClaimTable = memoryClaims(), quotaRetryMs = QUOTA_RETRY_MS) {
    this.quotaRetryMs = quotaRetryMs
    this.table = table
    this.claimed = claims
    this.specs = specs
    this.capabilities = capabilities
    this.lane = lane
    this.slots = slots
    slots.onFree(() => this.notify())
    this.running = new LiveAttempts(stallMinutes, (workId) => {
      const record = this.table.get(workId)
      if (record) this.tell({ workId, status: record.state.status, seq: record.events.at(-1)!.seq, type: 'stalled' })
    })
  }

  /** Call `listener` after every committed event, in the lane; it must not throw or wait. Returns the way to stop. */
  onChange(listener: (change: WorkChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The one change hook: every append, and the admission, end here. A listener's failure never reaches the Work. */
  private changed(record: WorkRecord): void {
    const event = record.events.at(-1)!
    this.tell({ workId: record.id, status: record.state.status, seq: event.seq, type: event.type })
  }

  private tell(change: WorkChange): void {
    for (const listener of this.listeners) {
      try { listener(change) } catch { /* a listener is not the Work's concern */ }
    }
  }

  /** The Work's running Worker attempts and what they last reported; empty when none runs. */
  live(workId: string): LiveAttempt[] {
    const waiting = (stepId: string, worker: string, since: number, kind: LiveAttempt['waiting'], until?: string): LiveAttempt => {
      const at = new Date(since).toISOString()
      return { stepId, attemptId: '', worker, startedAt: at, lastActivityAt: at, elapsedSeconds: Math.round((Date.now() - since) / 1000), quietSeconds: 0, stalled: false, waiting: kind, ...(until ? { until } : {}) }
    }
    const check = this.waitingForCheck.get(workId)
    return [
      ...this.running.of(workId),
      ...[...this.waitingForQuota.values()].filter((w) => w.workId === workId).map((w) => waiting(w.stepId, w.worker, w.since, 'quota', w.until)),
      ...(check ? [waiting(check.stepId, check.verifier, check.since, 'a check slot')] : []),
    ]
  }

  private now(): string {
    return new Date().toISOString()
  }

  /**
   * Pin the spec and create the Work record; nothing is dispatched yet. A
   * command's receipt is written with the record. The caller makes sure
   * `workId` is not taken.
   */
  async admit(admission: Admission, options: { workId?: string; command?: Command } = {}): Promise<WorkRecord> {
    const usesInput = admission.spec.steps.some((s) => refsOf(s).includes('$work.input'))
    if (usesInput && !admission.input) throw new WorkError('the workflow uses $work.input, but no input Artifact was given')
    if (admission.input && !this.specs.exists(admission.input)) throw new WorkError(`input ${admission.input} is not a stored Artifact`)
    const input = admission.input
    if (admission.worker) {
      if (!this.capabilities.workerRefs().includes(admission.worker)) throw new WorkError(`no enabled Worker ${admission.worker}; enabled: ${this.capabilities.workerRefs().join(', ') || 'none'}`)
      for (const s of admission.spec.steps.filter(isWorkerStep)) {
        const missing = s.capabilities.filter((c) => !this.capabilities.workerFor(admission.worker!)!.capabilities.includes(c))
        if (missing.length) throw new WorkError(`${admission.worker} does not provide ${s.capabilities.join(', ')} for step ${s.id} (lacks ${missing.join(', ')})`)
      }
    }
    // Pin every verify step's criteria now: later edits to a repository or a verifier's defaults cannot change them.
    const criteria: Record<string, string> = {}
    const verifiers: Record<string, { ref: string; version: string }> = {}
    for (const s of admission.spec.steps.filter(isVerifyStep)) {
      const verifier = this.capabilities.routeVerifier(s.verify.capability).selected
      if (!verifier) throw new WorkError(`no enabled verifier provides ${s.verify.capability}`)
      verifiers[s.id] = { ref: verifier.ref, version: verifier.version }
      try {
        criteria[s.id] = await verifier.criteria({ capability: s.verify.capability, name: s.verify.criteria, input: admission.input, operatorId: admission.caller.operatorId })
      } catch (error) {
        throw new WorkError(`step ${s.id}: ${verifier.ref} cannot pin criteria ${s.verify.criteria}: ${(error as Error).message}`)
      }
      if (!this.specs.exists(criteria[s.id]!)) throw new WorkError(`step ${s.id}: ${verifier.ref} returned criteria ${criteria[s.id]} that is not stored`)
    }
    for (const s of admission.spec.steps.filter(isEffectStep)) {
      const provider = this.capabilities.routeEffect(s.effect.capability).selected
      if (!provider) throw new WorkError(`no enabled provider offers ${s.effect.capability}`)
      try {
        provider.validate(s.effect.capability, { ...s.effect.params })
      } catch (error) {
        throw new WorkError(`step ${s.id}: ${provider.ref} refuses its params: ${(error as Error).message}`)
      }
    }
    const named = input ? this.specs.taskOf(input) : undefined
    const item = named?.task.item ? { id: named.task.item, ...(named.repository ? { repository: named.repository } : {}) } : undefined
    if (item && !admission.force) {
      const busy = activeWork(this.list(), item)
      if (busy) throw new WorkError(`Item ${item.id} already has Work ${busy.id} (${busy.state.status}, ${whoHas(busy).account ?? 'no Worker yet'}); to run another on purpose, give force (--force)`)
    }
    // A Task that names an Item is read with the Item's status and its earlier Works added to its context.
    const read = item ? await this.specs.withNote(input!, await itemNote(item, this.list(), this.specs.commitOf?.bind(this.specs)), admission.caller) : input
    const specId = await this.specs.putSpec(admission.spec, admission.caller)
    const id = options.workId ?? `work:${randomUUID()}`
    const admitted: WorkEvent = { type: 'admitted', seq: 0, at: this.now(), caller: admission.caller, specId, input: read, ...(item ? { item } : {}), ...(admission.worker ? { worker: admission.worker } : {}), criteria, verifiers, source: admission.source }
    const record: WorkRecord = {
      id, events: [admitted], state: fold(admission.spec.steps.map((s) => s.id), [admitted]),
      ...(options.command ? { receipts: [{ commandId: options.command.id, args: options.command.args, result: { workId: id, status: 'running' } }] } : {}),
    }
    await this.table.put(id, workRecordSchema.parse(record))
    // A Work for the Item takes over a session's claim on it.
    if (item?.repository) await this.claimed.delete(claimKey(item.repository, item.id))
    this.changed(record)
    return record
  }

  /** The claims on Items, by session. */
  claims(): Claim[] {
    return [...this.claimed.keys()].map((key) => this.claimed.get(key)!)
  }

  /**
   * Claim an Item for `caller` before submitting a Work for it. Refused while a Work for the Item is running or held,
   * and while another caller holds the claim unless `force`. Call it in the commit lane.
   */
  async claim(repository: string, item: string, caller: Caller, force = false): Promise<Claim> {
    const busy = activeWork(this.list(), { id: item, repository })
    if (busy) throw new WorkError(`Item ${item} already has Work ${busy.id} (${busy.state.status}, ${whoHas(busy).account ?? 'no Worker yet'})`)
    const held = this.claimed.get(claimKey(repository, item))
    if (held && held.who !== caller.operatorId && !force) throw new WorkError(`Item ${item} is claimed by ${held.who} since ${held.at}; to take it over on purpose, give force (--force)`)
    const claim: Claim = { repository, item, who: caller.operatorId, at: this.now() }
    await this.claimed.put(claimKey(repository, item), claim)
    return claim
  }

  get(workId: string): WorkRecord | undefined {
    return this.table.get(workId)
  }

  list(): WorkRecord[] {
    return [...this.table.keys()].map((key) => this.table.get(key)!)
  }

  /** The spec a Work runs: always the pinned Artifact, never the file. */
  specOf(record: WorkRecord): ResolvedSpec {
    const spec = this.specs.getSpec(record.state.specId)
    if (!spec) throw new WorkError(`the pinned spec ${record.state.specId} of ${record.id} is not stored`)
    return spec
  }

  /** Fold the recorded events again and compare with the stored state. */
  replay(workId: string): { state: WorkState; matches: boolean } {
    const record = this.require(workId)
    const state = fold(this.specOf(record).steps.map((s) => s.id), record.events)
    // Canonical form: storage may return keys in schema order, not insertion order.
    return { state, matches: canonicalJson(state) === canonicalJson(record.state) }
  }

  /** Advance until the Work is terminal, holding its lock. `started` is called once the lock is held, before the first step. */
  async run(workId: string, command?: Command, started?: () => void): Promise<WorkRecord> {
    const release = await this.enter(workId, command)
    try {
      started?.()
      return await this.drive(workId)
    } finally {
      this.leave(workId, release)
    }
  }

  /** Take the Work's lock; throws when it is already being run. Returns the release. */
  private lock(workId: string): () => void {
    if (this.locked.has(workId)) throw new WorkError(`${workId} is already being run`)
    this.locked.add(workId)
    return () => { this.locked.delete(workId) }
  }

  /** In the lane, take the Work's lock, so runs and cancels reach it in the order they were asked. */
  private enter(workId: string, command?: Command): Promise<() => void> {
    return this.lane(async () => {
      const release = this.lock(workId)
      if (command) this.expect(workId, command)
      return release
    })
  }

  private leave(workId: string, release: () => void): void {
    this.expected.delete(workId)
    release()
  }

  /** The command's receipt is written with the next `terminal` event of the Work. */
  private expect(workId: string, command: Command): void {
    this.expected.set(workId, [...(this.expected.get(workId) ?? []), { commandId: command.id, args: command.args, result: { workId, status: 'running' } }])
  }

  /**
   * Advance until the Work is terminal; the caller holds the lock. Each
   * decision is a section of the lane over the latest committed record; an
   * attempt runs outside it and comes back in to be observed. Several attempts
   * of the Work may be in flight at once.
   */
  private async drive(workId: string): Promise<WorkRecord> {
    this.driving.add(workId)
    try {
      return await this.advanceToEnd(workId)
    } finally {
      this.driving.delete(workId)
    }
  }

  private async advanceToEnd(workId: string): Promise<WorkRecord> {
    await this.lane(() => this.recover(this.require(workId)))
    const flying = new Set<Promise<void>>()
    const failures: unknown[] = []
    const fly = (settle: () => Promise<WorkRecord>) => {
      // A failed attempt is kept, not thrown here: only the drive's own loop rejects.
      const done: Promise<void> = settle().then(() => undefined, (error) => { failures.push(error) }).finally(() => {
        flying.delete(done)
        if (--this.attempts === 0) for (const wake of this.quiet) wake()
        // A decision made while it was still in flight is out of date.
        this.epoch++
      })
      flying.add(done)
    }
    // An attempt's observation may end the Work, so the record is read again at each turn.
    while (!TERMINAL.has(this.require(workId).state.status)) {
      const turn = await this.lane(async () => {
        const decided = await this.advance(workId, flying.size > 0)
        this.attempts += decided.settles.length
        return decided
      })
      for (const settle of turn.settles) fly(settle)
      if (failures.length) throw failures[0]
      if (TERMINAL.has(turn.record.state.status)) break
      if (turn.waiting) {
        // With nothing of its own in flight, the Work asks whether a lost attempt it waits on is gone by now.
        if (!flying.size && this.slots.uncertain().length && (await this.slots.settle()).length) continue
        if (this.epoch === turn.epoch) await this.idle(workId, flying)
      }
      if (failures.length) throw failures[0]
    }
    this.waitingForCheck.delete(workId)
    for (const key of [...this.waitingForQuota.keys()]) if (this.waitingForQuota.get(key)!.workId === workId) this.stopWaitingForQuota(key)
    // A step may fail the Work while others are in flight: they are observed, after the terminal event.
    await Promise.all(flying)
    if (failures.length) throw failures[0]
    return this.require(workId)
  }

  /** Wait until an attempt of the Work reports, or a slot is freed or a cancel asked. */
  private async idle(workId: string, flying: Set<Promise<void>>): Promise<void> {
    const changed = new Promise<void>((wake) => this.waiters.set(workId, wake))
    try {
      await Promise.race([...flying, changed])
    } finally {
      this.waiters.delete(workId)
    }
  }

  /** Wake the waiting drives, in Work admission order. */
  private notify(): void {
    this.epoch++
    const order = [...this.table.keys()]
    const woken = [...this.waiters.keys()].sort((a, b) => (this.admittedAt(a) < this.admittedAt(b) ? -1 : this.admittedAt(a) > this.admittedAt(b) ? 1 : order.indexOf(a) - order.indexOf(b)))
    for (const workId of woken) this.waiters.get(workId)?.()
  }

  private admittedAt(workId: string): string {
    return this.table.get(workId)?.events[0]?.at ?? ''
  }

  private async advance(workId: string, busy: boolean): Promise<Turn> {
    const record = this.require(workId)
    const cancel = this.cancels.get(workId)
    const unknown = Object.values(record.state.effects).find((e) => e.state === 'unknown')
    // Cancelling, or holding on an unknown effect, waits for the attempts in flight: they are aborted or finish, and are recorded first.
    if (busy && (cancel || unknown)) return { record, settles: [], waiting: true, epoch: this.epoch }
    if (cancel) return { record: await this.cancelled(record, cancel), settles: [], epoch: this.epoch }
    if (unknown) return { record: await this.finish(record, 'held', `the outcome of ${unknown.stepId} is unknown: ${lastReason(record, unknown.stepId)}; check the remote, then run the Work again`), settles: [], epoch: this.epoch }
    return this.step(record, busy)
  }

  /** Stop dispatching new attempts, and resolve once none is running. Works are still admitted and run; their drives wait. */
  async drain(): Promise<void> {
    this.draining = true
    // A section that began before has finished and counted what it dispatched; any later one sees the flag.
    await this.lane(async () => {})
    while (this.attempts > 0) await new Promise<void>((wake) => this.quiet.add(wake))
    this.quiet.clear()
  }

  /** The unfinished Works a drive is advancing, once every drive has settled at the gate of a drain. */
  async held(): Promise<string[]> {
    // The drives that just saw an attempt report reach the gate within the event loop's next turn.
    await new Promise((resolve) => setImmediate(resolve))
    await this.lane(async () => {})
    return [...this.driving].filter((id) => !TERMINAL.has(this.require(id).state.status))
  }

  runningElsewhere(workId: string): boolean {
    return this.locked.has(workId)
  }

  /**
   * Cancel Work. A live host running it is asked to stop its attempt (it
   * records the outcome itself); otherwise the outcome is recorded here.
   */
  async cancel(workId: string, request: CancelRequest, command?: Command): Promise<'requested' | WorkRecord> {
    return this.lane(async () => {
      const record = this.require(workId)
      if (TERMINAL.has(record.state.status)) throw new WorkError(`${workId} is already ${record.state.status}`)
      if (this.locked.has(workId)) {
        this.cancels.set(workId, request)
        this.notify()
        // The run that holds the Work records the cancellation; its terminal event carries this receipt too.
        if (command) this.expect(workId, command)
        return 'requested'
      }
      const release = this.lock(workId)
      if (command) this.expect(workId, command)
      try {
        return await this.cancelled(await this.recover(record), request)
      } finally {
        this.leave(workId, release)
      }
    })
  }

  /**
   * Take over a failed or cancelled Worker step with a new attempt, optionally
   * only by `worker`. The new attempt gets the same recorded inputs plus, as
   * `previous`, the partial output the last attempt left. A verify step is
   * asked again on the same subject with the same pinned criteria; its last
   * verdict stays recorded and no longer counts. Then run.
   */
  async retry(workId: string, options: RetryOptions, command?: Command, started?: () => void): Promise<WorkRecord> {
    const release = await this.enter(workId, command)
    try {
      await this.lane(() => this.reopen(workId, options))
      started?.()
      return await this.drive(workId)
    } finally {
      this.leave(workId, release)
    }
  }

  private async reopen(workId: string, options: RetryOptions): Promise<void> {
    const record = this.require(workId)
    if (!['failed', 'cancelled', 'held'].includes(record.state.status)) throw new WorkError(`only failed, cancelled or held Work is retried; ${workId} is ${record.state.status}`)
    if (options.worker && !this.capabilities.workerRefs().includes(options.worker)) throw new WorkError(`no enabled Worker ${options.worker}; enabled: ${this.capabilities.workerRefs().join(', ') || 'none'}`)
    const spec = this.specOf(record)
    const step = options.step
      ? spec.steps.find((s) => s.id === options.step && (isWorkerStep(s) || isVerifyStep(s) || isEffectStep(s)))
      : spec.steps.filter(isWorkerStep).find((s) => ['failed', 'cancelled', 'pending'].includes(record.state.steps[s.id]!.state) && (s.dependsOn ?? []).every((d) => settled(record, d)))
    if (!step) throw new WorkError(options.step ? `${options.step} is not a Worker, verify or effect step of ${workId}` : `${workId} has no Worker step to take over; name one with --step`)
    // Choosing among runs of a check would let an agent keep the lucky one: verifying again is the operator's.
    if (isVerifyStep(step) && options.caller.type !== 'human') throw new WorkError(`only a human verifies again; an ${options.caller.type} should tell the operator`)
    if (!isWorkerStep(step) && options.worker) throw new WorkError(`${step.id} is ${isVerifyStep(step) ? 'a verify' : 'an effect'} step; --worker names Workers only`)
    if (!(step.dependsOn ?? []).every((d) => settled(record, d))) throw new WorkError(`step ${step.id} depends on steps that have not succeeded`)
    const partial = Object.values(record.state.steps[step.id]!.partial ?? {})[0]
    const reset = [step.id, ...dependentsOf(spec, step.id)]
    this.cancels.delete(workId)
    await this.append(record, { type: 'reopened', caller: options.caller, stepId: step.id, reason: options.reason, worker: options.worker, previous: partial, reset })
  }

  private require(workId: string): WorkRecord {
    const record = this.table.get(workId)
    if (!record) throw new WorkError(`no Work ${workId}`)
    return record
  }

  private async append(record: WorkRecord, event: NewEvent): Promise<WorkRecord> {
    const stepIds = this.specOf(record).steps.map((s) => s.id)
    // The terminal event settles the commands waiting on this Work: their receipts go in the same update.
    const receipts = event.type === 'terminal' ? (this.expected.get(record.id) ?? []).map((r) => ({ ...r, result: { workId: record.id, status: event.outcome } })) : []
    if (receipts.length) this.expected.delete(record.id)
    const updated = await this.table.update(record.id, (current) => {
      const next = { ...event, seq: current.events.length, at: this.now() } as WorkEvent
      const events = [...current.events, next]
      return { ...current, events, state: fold(stepIds, events), ...(receipts.length ? { receipts: [...(current.receipts ?? []), ...receipts] } : {}) }
    })
    this.changed(updated)
    return updated
  }

  /**
   * Host start: mark the attempts of a Work that were dispatched but never
   * observed as lost, and reconcile its effects by reading the remote. Nothing
   * is dispatched or applied; only an explicit run or retry goes on.
   */
  async interrupt(workId: string): Promise<LostAttempt[]> {
    const record = this.require(workId)
    if (TERMINAL.has(record.state.status)) return []
    const lost = this.runningAttempts(record).map(([stepId, attemptId]) => ({ workId, stepId, attemptId }))
    // A Worker attempt's process may still run: it keeps its Account's slot (over the limit if need be) until settled. A verifier run holds a check slot only when its verifier limits them.
    for (const attempt of lost) {
      const dispatched = record.events.findLast((e) => e.type === 'dispatched' && e.attemptId === attempt.attemptId)
      if (dispatched?.type !== 'dispatched') continue
      if (dispatched.executor === 'worker') this.slots.hold(dispatched.selected, attempt)
      else if (dispatched.executor === 'verifier' && this.capabilities.verifierFor(dispatched.selected)?.maxConcurrentChecks !== undefined) this.slots.hold(checkAccount({ ref: dispatched.selected }), attempt)
    }
    await this.recover(record, { resumeEffects: false })
    return lost
  }

  /** The steps whose last attempt is dispatched and not observed, with that attempt; an effect step has none, and is reconciled instead. */
  private runningAttempts(record: WorkRecord): [string, string][] {
    return Object.entries(record.state.steps).filter(([, s]) => s.state === 'running' && s.attempts.length > 0).map(([stepId, s]) => [stepId, s.attempts.at(-1)!])
  }

  /** Mark attempts that were dispatched but never observed as lost. */
  private async recover(record: WorkRecord, { resumeEffects = true } = {}): Promise<WorkRecord> {
    for (const [stepId, attemptId] of this.runningAttempts(record)) {
      record = await this.append(record, { type: 'attempt-lost', stepId, attemptId, reason: 'the host stopped before the attempt reported' })
    }
    // An effect whose outcome was not recorded is never applied again blindly: reconcile first.
    for (const [operationId, effect] of Object.entries(record.state.effects)) {
      // Read as absent by a Host's start, which applies nothing: an explicit run applies it.
      const unapplied = effect.state === 'absent' && resumeEffects && record.state.steps[effect.stepId]!.state === 'running'
      if (effect.state !== 'intended' && effect.state !== 'unknown' && !unapplied) continue
      const intent = this.intentOf(record, operationId)
      const provider = this.capabilities.routeEffect(intent.capability).selected
      if (!provider) {
        record = await this.append(record, { type: 'effect-observed', stepId: effect.stepId, operationId, state: 'unknown', reason: `no enabled provider of ${intent.capability} can reconcile it` })
        continue
      }
      record = unapplied ? await this.applyEffect(record, provider, intent) : await this.reconcile(record, provider, intent, resumeEffects ? 'apply-if-absent' : 'record-only')
    }
    return record
  }

  /** Rebuild the recorded intent of an operation. */
  private intentOf(record: WorkRecord, operationId: string): EffectIntent {
    const event = record.events.findLast((e) => e.type === 'effect-intended' && e.operationId === operationId)
    if (event?.type !== 'effect-intended') throw new WorkError(`no recorded intent for ${operationId}`)
    const step = this.specOf(record).steps.find((s) => s.id === event.stepId)
    return { operationId, workId: record.id, stepId: event.stepId, capability: event.capability, subject: event.subject, params: event.params, required: step && isEffectStep(step) ? this.requiredOf(record, step) : [],
      ...(step && isEffectStep(step) && step.effect.requires.some((id) => this.verdictOf(record, this.specOf(record), id) === 'inconclusive') && this.decisionOf(record, step.id) ? { acceptedInconclusive: true } : {}) }
  }

  /** The verify steps an effect step requires, with the criteria pinned for each at admission. */
  private requiredOf(record: WorkRecord, s: Extract<Step, { effect: unknown }>): { capability: string; criteria: string }[] {
    const spec = this.specOf(record)
    return s.effect.requires.flatMap((id) => {
      const verify = spec.steps.find((t) => t.id === id)
      const criteria = record.state.criteria[id]
      return verify && isVerifyStep(verify) && criteria ? [{ capability: verify.verify.capability, criteria }] : []
    })
  }

  /** Read the remote; apply only when it shows the effect absent and `then` allows it. */
  private async reconcile(record: WorkRecord, provider: EffectPort, intent: EffectIntent, then: 'apply-if-absent' | 'record-only'): Promise<WorkRecord> {
    let found: Reconciled
    try {
      found = await provider.reconcile(intent)
    } catch (error) {
      found = { state: 'unknown', reason: `reconciliation failed: ${(error as Error).message}` }
    }
    record = await this.append(record, {
      type: 'effect-observed', stepId: intent.stepId, operationId: intent.operationId, state: found.state, reason: found.reason,
      ...(found.state === 'applied' ? { detail: found.detail } : {}),
    })
    return found.state === 'absent' && then === 'apply-if-absent' ? this.applyEffect(record, provider, intent) : record
  }

  /** Execute and observe an effect whose intent is recorded. */
  private async applyEffect(record: WorkRecord, provider: EffectPort, intent: EffectIntent): Promise<WorkRecord> {
    return this.observeEffect(record.id, provider, intent, await this.executeEffect(provider, intent))
  }

  /** Outside the lane: apply the effect, touching no Work state. */
  private async executeEffect(provider: EffectPort, intent: EffectIntent): Promise<EffectOutcome | Error> {
    try {
      return await provider.apply(intent)
    } catch (error) {
      return error as Error
    }
  }

  /** In the lane: read the committed record again and append the outcome. */
  private async observeEffect(workId: string, provider: EffectPort, intent: EffectIntent, applied: EffectOutcome | Error): Promise<WorkRecord> {
    const record = this.require(workId)
    if (applied instanceof Error) {
      // The remote may or may not have changed: read it, and never retry here.
      const after = await this.reconcile(record, provider, intent, 'record-only')
      const effect = after.state.effects[intent.operationId]!
      if (effect.state === 'absent') return this.finish(after, 'failed', `${intent.stepId} failed: ${applied.message}; the remote shows nothing published`)
      return after
    }
    return this.append(record, { type: 'effect-observed', stepId: intent.stepId, operationId: intent.operationId, state: applied.state, reason: applied.reason, detail: applied.detail, ...(applied.rejected ? { rejected: applied.rejected } : {}) })
  }

  /** In the lane: dispatch every ready step that can start now, in Workflow file order. */
  private async step(record: WorkRecord, busy: boolean): Promise<Turn> {
    const spec = this.specOf(record)
    const epoch = this.epoch
    const done = (stepId: string) => settled(record, stepId)
    if (!busy) record = await this.retryAutomatically(record, spec)
    const failed = spec.steps.find((s) => ['failed', 'cancelled'].includes(record.state.steps[s.id]!.state))
    // A failed step fails the Work once the attempts in flight have reported.
    if (failed && busy) return { record, settles: [], waiting: true, epoch }
    if (failed) return { record: await this.finish(record, 'failed', `step ${failed.id} ${record.state.steps[failed.id]!.state}`), settles: [], epoch }
    // A `fail` or `error` verdict no retry reopened is the Work's outcome (inconclusive waits for the operator at the end):
    // a step after it never starts, so nothing builds on, or publishes, what failed its check.
    const verdicts = spec.steps.filter(isVerifyStep).map((s) => [s.id, this.verdictOf(record, spec, s.id)] as const)
    const refused = verdicts.find(([stepId, verdict]) => (verdict === 'fail' || verdict === 'error') && spec.steps.some((s) => s.dependsOn?.includes(stepId)))
    if (refused && busy) return { record, settles: [], waiting: true, epoch }
    if (refused) return { record: await this.finish(record, 'failed', `verification did not pass: ${refused[0]}=${refused[1]}`), settles: [], epoch }
    const ready = spec.steps.filter((s) => record.state.steps[s.id]!.state === 'pending' && (s.dependsOn ?? []).every(done))
    // A step whose condition on an optional output is not met does not run (ro-15); what comes after it goes on.
    const skipped = ready.flatMap((s) => { const why = skipReason(record, s); return why ? [{ stepId: s.id, why }] : [] })
    if (skipped.length) {
      for (const { stepId, why } of skipped) record = await this.append(record, { type: 'skipped', stepId, reason: why })
      return this.step(record, busy)
    }
    if (!ready.length && busy) return { record, settles: [], waiting: true, epoch }
    if (!ready.length) return { record: await this.finishWithoutAccept(record, spec), settles: [], epoch }
    const settles: (() => Promise<WorkRecord>)[] = []
    let waiting = false
    for (const next of ready) {
      let turn: Turn
      // Draining: an attempt is what an upgrade waits for, so none begins; accepting is no attempt.
      if (this.draining && (isWorkerStep(next) || isVerifyStep(next) || isEffectStep(next))) { waiting = true; continue }
      if (isWorkerStep(next)) {
        const dispatched = await this.dispatchWorker(record, next)
        if (dispatched.blocked) { waiting = true; continue }
        const { attempt } = dispatched
        turn = this.attemptTurn(dispatched.record, attempt && (async () => {
          try {
            const execution = await this.executeWorker(attempt)
            return await this.lane(() => this.observeWorker(attempt, execution, spec))
          } finally {
            this.slots.release(attempt.worker.ref, attempt.attemptId)
          }
        }))
      } else if (isVerifyStep(next)) {
        const verifying = await this.runVerifier(record, next)
        if (!verifying) { waiting = true; continue }
        turn = verifying
      } else if (isEffectStep(next)) {
        turn = await this.runEffect(record, spec, next)
      } else {
        // Accepting decides the Work: only when nothing else is running or was started.
        if (busy || settles.length || waiting) { waiting = true; continue }
        return { record: await this.accept(record, next), settles, epoch }
      }
      record = turn.record
      settles.push(...turn.settles)
      if (TERMINAL.has(record.state.status)) return { record, settles, epoch }
    }
    return { record, settles, waiting: !settles.length && (waiting || busy), epoch }
  }

  /**
   * In the lane, with nothing in flight: the Workflow's `retry` (Item df-7; the rule is in
   * [workflow composition](../../../docs/architecture/workflow-composition.md)). The count comes from
   * recorded events; the latest step in dependency order with budget is reopened; a failed verdict
   * is handed to the new attempt as input `failure`.
   */
  private async retryAutomatically(record: WorkRecord, spec: ResolvedSpec): Promise<WorkRecord> {
    if (TERMINAL.has(record.state.status)) return record
    const workers = spec.steps.filter(isWorkerStep)
    const reopen = (s: (typeof workers)[number], reason: string, failure?: string): Promise<WorkRecord> => {
      const previous = failure ? record.state.steps[s.id]!.outputs[s.outputs[0]!] : undefined
      return this.append(record, { type: 'reopened', automatic: true, stepId: s.id, reason, ...(failure ? { failure } : {}), ...(previous ? { previous } : {}), reset: [s.id, ...dependentsOf(spec, s.id)] })
    }
    const autoReopens = (stepId: string, source: string): number => record.events.filter((e) => {
      if (e.type !== 'reopened' || !e.automatic || e.stepId !== stepId) return false
      if (e.failedEffect) return e.failedEffect === source
      if (source === stepId) return !e.failure
      return record.events.some((v) => v.type === 'verified' && v.stepId === source && v.verdictId === e.failure)
    }).length
    for (const v of spec.steps.filter(isVerifyStep)) {
      if (this.verdictOf(record, spec, v.id) !== 'fail') continue
      const verified = record.events.findLast((e) => e.type === 'verified' && e.stepId === v.id)
      if (verified?.type !== 'verified') continue
      const nearest = workers.findLast((s) => s.retry?.onFail.includes(v.id) && record.state.steps[s.id]!.state === 'succeeded' && autoReopens(s.id, v.id) < s.retry.max)
      if (nearest) return reopen(nearest, `${v.id} failed: ${verified.reason}`, verified.verdictId)
    }
    // An effect step whose outcome was observed as a conflict or a failed merge check reopens the Worker step that lists it, on the base's new tip.
    // An unknown or reconciled outcome never carries `rejected`, so it is never retried.
    for (const e of spec.steps.filter(isEffectStep)) {
      if (record.state.steps[e.id]!.state !== 'failed') continue
      const observed = record.events.findLast((x) => x.type === 'effect-observed' && x.stepId === e.id)
      const base = observed?.type === 'effect-observed' ? observed.detail?.base : undefined
      if (observed?.type !== 'effect-observed' || observed.state !== 'failed' || !observed.rejected || !base) continue
      const target = workers.findLast((s) => s.retry?.onFail.includes(e.id) && record.state.steps[s.id]!.state === 'succeeded' && autoReopens(s.id, e.id) < s.retry.max)
      const previous = target && record.state.steps[target.id]!.outputs[target.outputs[0]!]
      if (!target || !previous) continue
      const failure = await this.specs.putVerdict({ subject: previous, criteria: previous, capability: 'publish', verifier: { ref: `step:${e.id}`, version: '1' }, verdict: 'fail', reason: observed.reason, evidence: [] })
      return this.append(record, { type: 'reopened', automatic: true, failedEffect: e.id, stepId: target.id, reason: `${e.id} failed: ${observed.reason}`, failure, previous, base, reset: [target.id, ...dependentsOf(spec, target.id)] })
    }
    for (const s of workers) {
      if (!s.retry?.onFail.includes(s.id) || record.state.steps[s.id]!.state !== 'failed' || autoReopens(s.id, s.id) >= s.retry.max) continue
      const observed = record.events.findLast((e) => e.type === 'observed' && e.stepId === s.id)
      if (observed?.type === 'observed' && observed.retryable) return reopen(s, `${s.id} failed and may be tried afresh: ${observed.reason ?? 'no reason'}`)
    }
    return record
  }

  private attemptTurn(record: WorkRecord, settle: (() => Promise<WorkRecord>) | undefined): Turn {
    return { record, settles: settle ? [settle] : [], epoch: this.epoch }
  }

  /** Resolve a reference to an exact Artifact ID from recorded state. */
  private resolveRef(record: WorkRecord, ref: string): string {
    if (ref === '$work.input') return record.state.input!
    // `$steps.<step>.<slot>`: a joined Sub-workflow's step ID has dots of its own.
    const names = ref.split('.')
    const id = record.state.steps[names.slice(1, -1).join('.')]?.outputs[names.at(-1)!]
    if (!id) throw new WorkError(`${ref} has no recorded Artifact`)
    return id
  }

  /** In the lane: decide from the committed record and append `dispatched`; `attempt` is absent when the step failed instead, `blocked` when its Account has no free slot. */
  private async dispatchWorker(record: WorkRecord, s: Extract<Step, { capabilities: string[] }>): Promise<{ record: WorkRecord; attempt?: WorkerAttempt; blocked?: boolean }> {
    const inputs = Object.fromEntries(Object.entries(s.inputs ?? {}).map(([name, ref]) => [name, this.resolveRef(record, ref)]))
    const reopened = record.events.findLast((e) => e.type === 'reopened' && e.stepId === s.id)
    const takeover = reopened?.type === 'reopened' ? reopened : undefined
    if (takeover?.previous) inputs.previous = takeover.previous
    if (takeover?.failure) inputs.failure = takeover.failure
    if (takeover?.base) inputs.base = takeover.base
    const admitted = record.events[0]
    const only = takeover?.worker ?? (admitted?.type === 'admitted' ? admitted.worker : undefined)
    const waitKey = `${record.id}/${s.id}`
    // The readings are taken here, once, and recorded with the choice: replay reads the record, never the provider.
    const capable = this.capabilities.rankable(s.capabilities, only, (w) => this.slots.hasFree(w))
    const route = this.capabilities.routeWorker(s.capabilities, only, (w) => this.slots.hasFree(w), await this.readQuotas(capable), this.activeLimited(), this.attemptsToday(), s.prefer)
    if (route.quotaWait) {
      const was = this.waitingForQuota.get(waitKey)
      if (!was || was.until !== route.quotaWait.resetsAt) {
        if (was) clearTimeout(was.timer)
        const delay = Math.min(this.quotaRetryMs, route.quotaWait.resetsAt ? Math.max(0, Date.parse(route.quotaWait.resetsAt) - Date.now()) : this.quotaRetryMs)
        const timer = setTimeout(() => { this.waitingForQuota.delete(waitKey); this.notify() }, delay)
        // A retry timer never keeps the process alive by itself.
        timer.unref()
        this.waitingForQuota.set(waitKey, { workId: record.id, stepId: s.id, worker: capable[0]!.ref, since: was?.since ?? Date.now(), ...(route.quotaWait.resetsAt ? { until: route.quotaWait.resetsAt } : {}), timer })
      }
      return { record, blocked: true }
    }
    if (route.full) {
      if (!this.waitingForSlot.has(waitKey)) this.waitingForSlot.set(waitKey, Date.now())
      return { record, blocked: true }
    }
    if (!route.selected) return { record: await this.finish(record, 'failed', `no enabled Worker ${only ? `${only} ` : ''}provides ${s.capabilities.join(', ')} for step ${s.id}`) }
    const attemptId = `attempt:${randomUUID()}`
    if (!this.slots.reserve(route.selected, attemptId)) return { record, blocked: true }
    const waitedMs = this.waited(Math.min(this.waitingForSlot.get(waitKey) ?? Infinity, this.waitingForQuota.get(waitKey)?.since ?? Infinity))
    this.waitingForSlot.delete(waitKey)
    this.stopWaitingForQuota(waitKey)
    try {
      record = await this.append(record, {
        type: 'dispatched', stepId: s.id, attemptId, executor: 'worker', capability: s.capabilities.join(','),
        selected: route.selected.ref, candidates: route.candidates, inputs, ...waitedMs,
      })
    } catch (error) {
      this.slots.release(route.selected.ref, attemptId)
      throw error
    }
    return { record, attempt: { workId: record.id, attemptId, step: s, worker: route.selected, inputs } }
  }

  /** The quota of each of the Workers that has one; a reader that throws is an unreadable Account, never a failed step. */
  private activeLimited(): ReadonlySet<string> {
    const now = Date.now()
    for (const [ref, until] of this.limitedAccounts) if (until <= now) this.limitedAccounts.delete(ref)
    return new Set(this.limitedAccounts.keys())
  }

  /** Worker attempts dispatched since 00:00 UTC, by Account (limited ones included); read from the table, never recorded. */
  private attemptsToday(): Map<string, number> {
    const start = new Date().setUTCHours(0, 0, 0, 0)
    const counts = new Map<string, number>()
    for (const record of this.list()) {
      for (let i = record.events.length - 1; i >= 0; i--) {
        const e = record.events[i]!
        if (Date.parse(e.at) < start) break
        if (e.type === 'dispatched' && e.executor === 'worker') counts.set(e.selected, (counts.get(e.selected) ?? 0) + 1)
      }
    }
    return counts
  }

  private async readQuotas(workers: readonly WorkerPort[]): Promise<Map<string, QuotaReading>> {
    const read = await Promise.all(workers.filter((w) => w.quota).map(async (w): Promise<[string, QuotaReading]> => {
      try { return [w.ref, await w.quota!()] } catch (error) { return [w.ref, { unreadable: (error as Error).message }] }
    }))
    return new Map(read)
  }

  private stopWaitingForQuota(key: string): void {
    clearTimeout(this.waitingForQuota.get(key)?.timer)
    this.waitingForQuota.delete(key)
  }

  /** `waitedMs` for a dispatch of a step that waited since `since`. */
  private waited(since: number | undefined): { waitedMs?: number } {
    const ms = since === undefined ? 0 : Date.now() - since
    return ms > 0 ? { waitedMs: ms } : {}
  }

  /** Outside the lane: run the Worker, touching no Work state. */
  private async executeWorker(attempt: WorkerAttempt): Promise<WorkerExecution> {
    const { workId, attemptId, step: s, inputs } = attempt
    const abort = new AbortController()
    const poll = setInterval(() => { if (this.cancels.get(workId)) abort.abort() }, CANCEL_POLL_MS)
    // A poll never keeps the process alive by itself.
    poll.unref()
    const progress = this.running.start({ workId, stepId: s.id, attemptId, worker: attempt.worker.ref })
    try {
      return { result: await attempt.worker.run({ workId, attemptId, stepId: s.id, capabilities: s.capabilities, inputs, outputs: s.outputs, ...(s.optionalOutputs ? { optionalOutputs: s.optionalOutputs } : {}), instructions: s.instructions, signal: abort.signal, progress }), aborted: abort.signal.aborted }
    } catch (error) {
      return { result: { status: abort.signal.aborted ? 'cancelled' : 'failed', outputs: {}, reason: `the Worker threw: ${(error as Error).message}` }, aborted: abort.signal.aborted }
    } finally {
      clearInterval(poll)
      this.running.end(attemptId)
    }
  }

  /** In the lane: read the committed record again and append the outcome. */
  private async observeWorker(attempt: WorkerAttempt, { result, aborted }: WorkerExecution, spec: ResolvedSpec): Promise<WorkRecord> {
    const { workId, attemptId, step: s } = attempt
    let { status, reason } = result
    if (aborted) status = 'cancelled'
    const outputs = status === 'succeeded' ? result.outputs : {}
    let unchangedAfter: string | undefined
    if (status === 'succeeded') {
      // A Worker's word is not its output: every declared slot must name a stored Artifact.
      const missing = [...s.outputs.filter((slot) => !outputs[slot] || !this.specs.exists(outputs[slot])), ...(s.optionalOutputs ?? []).filter((slot) => outputs[slot] && !this.specs.exists(outputs[slot]))]
      if (missing.length) [status, reason] = ['failed', `the Worker reported success without stored outputs ${missing.join(', ')}`]
      // A change that is judged or published must be one: a Worker that changed nothing fails here, not three steps later.
      // Only a first output that a later verify or effect step takes as its subject, so a read-only step's `checkout` stays unchanged.
      // A step that wrote its optional output has said the Item already holds: its change is meant to be the base (Satisfied, ro-15).
      const holds = (s.optionalOutputs ?? []).some((slot) => outputs[slot])
      if (status === 'succeeded' && s.outputs[0] && !s.mayBeEmpty && !holds && isJudged(spec, s.id, s.outputs[0])) {
        const base = this.specs.unchangedBase(outputs[s.outputs[0]]!)
        if (base) {
          const said = result.message?.replace(/\s+/g, ' ').trim()
          unchangedAfter = s.retry?.rerunUnchanged ? this.failingCheckOf(this.require(workId), s) : undefined
          if (unchangedAfter) {
            // The step was reopened by a failing check and changed nothing: the check runs again on the change it failed.
            outputs[s.outputs[0]] = this.latestReopening(this.require(workId), s.id)!.previous!
            reason = `no change: ran the check again on the same change${said ? `. The Worker said: ${said.length > 300 ? `${said.slice(0, 300)}…` : said}` : ''}`
          } else [status, reason] = ['failed', `no change: the working tree is the same as the base commit ${base.slice(0, 7)}${said ? `. The Worker said: ${said.length > 300 ? `${said.slice(0, 300)}…` : said}` : ''}`]
        }
      }
    }
    const partial = Object.fromEntries(Object.entries(result.partial ?? {}).filter(([, id]) => this.specs.exists(id)))
    // A cancel request is recorded by the drive, once every attempt of the Work has reported.
    const limited = status === 'failed' && !aborted && isQuotaLimited(reason)
    if (limited) {
      this.limitedAccounts.set(attempt.worker.ref, Date.now() + this.quotaRetryMs)
      // Drop the cached reading and read it again now; an unreadable Account is never a failure.
      try { await attempt.worker.quota?.(true) } catch { /* routing reads it again */ }
    }
    return this.append(this.require(workId), {
      type: 'observed', stepId: s.id, attemptId, status, outputs: status === 'succeeded' ? pick(outputs, [...s.outputs, ...(s.optionalOutputs ?? []).filter((slot) => outputs[slot])]) : {}, reason,
      usage: result.usage ? { state: 'observed', ...result.usage } : { state: 'unknown' },
      ...(Object.keys(partial).length ? { partial } : {}),
      ...(result.log && this.specs.exists(result.log) ? { log: result.log } : {}),
      ...(result.executor ? { worker: result.executor } : {}),
      ...(limited ? { limited: true as const } : {}),
      ...(unchangedAfter ? { unchangedAfter } : {}),
      // An Account that no longer offers the step's capabilities left routing because of this failure: another may take it (ro-12).
      ...(status === 'failed' && (result.retryable || s.capabilities.some((c) => !attempt.worker.capabilities.includes(c))) && !aborted ? { retryable: true as const } : {}),
    })
  }

  /** Record cancellation as terminal; a still-running step is marked lost first. */
  private async cancelled(record: WorkRecord, request: CancelRequest): Promise<WorkRecord> {
    record = await this.recover(record, { resumeEffects: false })
    const done = await this.append(record, { type: 'terminal', outcome: 'cancelled', reason: `cancelled by ${request.caller.type} ${request.caller.operatorId}: ${request.reason}`, results: {}, caller: request.caller })
    this.cancels.delete(record.id)
    return done
  }

  /** `undefined` when the verifier's check slots are all taken: the step waits for one. */
  private async runVerifier(record: WorkRecord, s: Extract<Step, { verify: unknown }>): Promise<Turn | undefined> {
    const dispatched = await this.dispatchVerifier(record, s)
    if (dispatched.blocked) return undefined
    const { attempt } = dispatched
    return this.attemptTurn(dispatched.record, attempt && (async () => {
      try {
        const result = await this.executeVerifier(attempt)
        return await this.lane(() => this.observeVerifier(attempt, result))
      } finally {
        this.slots.release(checkAccount(attempt.verifier), attempt.attemptId)
      }
    }))
  }

  /** In the lane: decide from the committed record and append `dispatched`; `attempt` is absent when the step failed instead, `blocked` when the verifier has no free check slot. */
  private async dispatchVerifier(record: WorkRecord, s: Extract<Step, { verify: unknown }>): Promise<{ record: WorkRecord; attempt?: VerifierAttempt; blocked?: boolean }> {
    const subject = this.resolveRef(record, s.verify.subject)
    const inputs = Object.fromEntries(Object.entries(s.verify.inputs ?? {}).map(([name, ref]) => [name, this.resolveRef(record, ref)]))
    const criteria = record.state.criteria[s.id]
    if (!criteria) return { record: await this.finish(record, 'failed', `step ${s.id} has no pinned criteria`) }
    const route = this.capabilities.routeVerifier(s.verify.capability)
    if (!route.selected) return { record: await this.finish(record, 'failed', `no enabled verifier provides ${s.verify.capability} for step ${s.id}`) }
    const verifier = route.selected
    const attemptId = `attempt:${randomUUID()}`
    if (!this.slots.reserveCheck(verifier, attemptId)) {
      const was = this.waitingForCheck.get(record.id)
      this.waitingForCheck.set(record.id, { stepId: s.id, verifier: verifier.ref, since: was?.stepId === s.id ? was.since : Date.now() })
      return { record, blocked: true }
    }
    const waiting = this.waitingForCheck.get(record.id)
    const waitedMs = this.waited(waiting?.stepId === s.id ? waiting.since : undefined)
    this.waitingForCheck.delete(record.id)
    const kind = this.specs.kindOf(subject)
    const admitted = record.events[0]
    const pinned = admitted?.type === 'admitted' ? admitted.verifiers?.[s.id] : undefined
    let refusal: string | undefined
    if (pinned && (pinned.ref !== verifier.ref || pinned.version !== verifier.version)) refusal = `pinned ${pinned.ref}@${pinned.version} at admission; ${verifier.ref}@${verifier.version} is enabled now`
    else if (!kind || !verifier.accepts.includes(kind)) refusal = `${verifier.ref} judges ${verifier.accepts.join(', ')}, not ${kind ?? 'a missing Artifact'}`
    try {
      record = await this.append(record, {
        type: 'dispatched', stepId: s.id, attemptId, executor: 'verifier', capability: s.verify.capability,
        selected: verifier.ref, candidates: route.candidates, inputs: { ...inputs, subject, criteria }, ...waitedMs,
      })
    } catch (error) {
      this.slots.release(checkAccount(verifier), attemptId)
      throw error
    }
    const earlier = record.events.flatMap((e) => e.type === 'verified' && e.stepId === s.id && e.criteria === criteria && e.verdict !== 'pass' ? e.evidence ?? [] : [])
    return { record, attempt: { workId: record.id, attemptId, step: s, verifier, subject, criteria, inputs, earlier, refusal } }
  }

  /** Outside the lane: ask the verifier, touching no Work state. */
  private async executeVerifier({ workId, attemptId, step: s, verifier, subject, criteria, inputs, earlier, refusal }: VerifierAttempt): Promise<VerifyResult> {
    if (refusal) return { verdict: 'error', reason: refusal, subject, criteria, evidence: [] }
    try {
      return await verifier.verify({ workId, attemptId, stepId: s.id, capability: s.verify.capability, subject, criteria, ...(Object.keys(inputs).length ? { inputs } : {}), ...(earlier.length ? { earlier } : {}) })
    } catch (error) {
      return { verdict: 'error', reason: `the verifier threw: ${(error as Error).message}`, subject, criteria, evidence: [] }
    }
  }

  private latestReopening(record: WorkRecord, stepId: string) {
    const e = record.events.findLast((r) => r.type === 'reopened' && r.stepId === stepId)
    return e?.type === 'reopened' ? e : undefined
  }

  /** The verdict of a check in `retry.onFail` that automatically reopened this step, with its change to hand back (`retry.rerunUnchanged`). */
  private failingCheckOf(record: WorkRecord, s: Extract<Step, { capabilities: string[] }>): string | undefined {
    const r = this.latestReopening(record, s.id)
    if (!r?.automatic || !r.failure || r.failedEffect || !r.previous) return undefined
    return record.events.some((v) => v.type === 'verified' && v.verdictId === r.failure && v.verdict === 'fail' && s.retry?.onFail.includes(v.stepId)) ? r.failure : undefined
  }

  /** In the lane: read the committed record again and append the verdict. */
  private async observeVerifier({ workId, attemptId, step: s, verifier, subject, criteria }: VerifierAttempt, result: VerifyResult): Promise<WorkRecord> {
    const record = this.require(workId)
    let bound = this.bind(result, subject, criteria)
    // The second run of a check on the same change (`retry.rerunUnchanged`): a pass is flaky, a second fail is held for the operator as inconclusive.
    const lastRun = record.events.findLast((e) => e.type === 'verified' && e.stepId === s.id)
    const first = lastRun?.type === 'verified' && lastRun.verdict === 'fail' && lastRun.verdictId
      && record.events.some((e) => e.type === 'observed' && e.seq > lastRun.seq && e.unchangedAfter === lastRun.verdictId) ? lastRun : undefined
    if (first && bound.verdict === 'pass') bound = { ...bound, reason: `flaky: failed (${first.verdictId}) then passed on the same change; ${bound.reason}` }
    else if (first && bound.verdict === 'fail') bound = { verdict: 'inconclusive', reason: `failed twice on the same change, held for an operator decision (verifier said fail: ${bound.reason}); first run ${first.verdictId}`, evidence: [...(first.evidence ?? []), ...(bound.evidence ?? [])] }
    const verdictId = await this.specs.putVerdict({
      subject, criteria, capability: s.verify.capability, verifier: { ref: verifier.ref, version: verifier.version },
      verdict: bound.verdict, reason: bound.reason, evidence: bound.evidence,
    })
    return this.append(record, {
      type: 'verified', stepId: s.id, attemptId, subject, criteria,
      verdict: bound.verdict, reason: bound.reason, verdictId, evidence: bound.evidence,
      ...(first ? { rerunOf: first.verdictId } : {}),
      verifier: { ref: verifier.ref, version: verifier.version },
    })
  }

  /** A verdict counts only for the exact subject and criteria asked about, with stored evidence; anything else is `error`. */
  private bind(result: VerifyResult, subject: string, criteria: string): Pick<VerifyResult, 'verdict' | 'reason' | 'evidence'> {
    const evidence = [...new Set(result.evidence ?? [])]
    const problems: string[] = []
    if (result.subject !== subject) problems.push(`it judged ${result.subject}, not the subject ${subject}`)
    if (result.criteria !== criteria) problems.push(`it used criteria ${result.criteria}, not the pinned ${criteria}`)
    const missing = evidence.filter((id) => !this.specs.exists(id))
    if (missing.length) problems.push(`its evidence ${missing.join(', ')} is not stored`)
    if (result.verdict === 'pass' && !evidence.length) problems.push('a pass needs evidence')
    if (problems.length) return { verdict: 'error', reason: `verdict refused: ${problems.join('; ')} (verifier said ${result.verdict}: ${result.reason})`, evidence: evidence.filter((id) => this.specs.exists(id)) }
    return { verdict: result.verdict, reason: result.reason, evidence }
  }

  /** A verify step's verdict about an output that has since changed no longer counts. */
  private verdictOf(record: WorkRecord, spec: ResolvedSpec, stepId: string): string | undefined {
    const s = spec.steps.find((step) => step.id === stepId)
    const state = record.state.steps[stepId]!
    if (!s || !isVerifyStep(s) || !state.verdict) return state.verdict
    let current: string | undefined
    try {
      current = this.resolveRef(record, s.verify.subject)
    } catch {
      current = undefined
    }
    return current === state.subject ? state.verdict : 'stale'
  }

  /** With no accept step, every verify step still decides: missing evidence is never a pass. */
  private finishWithoutAccept(record: WorkRecord, spec: ResolvedSpec): Promise<WorkRecord> {
    const verifies = spec.steps.filter(isVerifyStep).filter((s) => record.state.steps[s.id]!.state !== 'skipped')
    const verdicts = verifies.map((s) => [s.id, this.verdictOf(record, spec, s.id)] as const)
    const bad = verdicts.filter(([, verdict]) => verdict !== 'pass' && verdict !== 'inconclusive')
    if (bad.length) return this.finish(record, 'failed', `verification did not pass: ${bad.map(([id, v]) => `${id}=${v ?? 'missing'}`).join(', ')}`)
    const unsure = verdicts.filter(([id, verdict]) => verdict === 'inconclusive' && !this.decisionOf(record, id))
    if (unsure.length) return this.finish(record, 'held', `inconclusive verification needs an operator decision: ${unsure.map(([id]) => id).join(', ')}`)
    // A passing verify step with `result` says the Item already holds: the Work ends Satisfied, with its verdict as the evidence.
    const satisfying = verifies.find((s) => s.result && this.verdictOf(record, spec, s.id) === 'pass')
    if (satisfying?.result) {
      const verdictId = record.events.findLast((e) => e.type === 'verified' && e.stepId === satisfying.id)
      return this.finish(record, 'succeeded', `${satisfying.result}: ${satisfying.id} passed`, undefined, { result: satisfying.result, evidence: { [`${satisfying.id}.verdict`]: verdictId?.type === 'verified' && verdictId.verdictId ? verdictId.verdictId : '' } })
    }
    return this.finish(record, 'succeeded', 'every step succeeded')
  }

  private accept(record: WorkRecord, s: Extract<Step, { accept: unknown }>): Promise<WorkRecord> {
    const spec = this.specOf(record)
    const verdicts = s.accept.requires.map((stepId) => [stepId, this.verdictOf(record, spec, stepId)] as const)
    const notPass = verdicts.filter(([, verdict]) => verdict !== 'pass')
    // Missing evidence is never a pass; inconclusive is held for the operator, not failed (ADR-0003 decision 8).
    if (notPass.some(([, verdict]) => verdict !== 'inconclusive')) {
      return this.finish(record, 'failed', `required verification did not pass: ${notPass.map(([id, v]) => `${id}=${v ?? 'missing'}`).join(', ')}`)
    }
    // One approval serves an effect step that requires the same verify steps (df-25: publish's approval of an inconclusive verdict).
    const decided = this.decisionOf(record, s.id) ?? (notPass.length ? this.effectDecisionOn(record, spec, notPass.map(([id]) => id)) : undefined)
    if (notPass.length) {
      if (!decided) return this.finish(record, 'held', `inconclusive verification needs an operator decision: ${notPass.map(([id]) => id).join(', ')}`, s.id)
      return this.finish(record, 'succeeded', `accepted by ${decided.caller.operatorId} despite inconclusive ${notPass.map(([id]) => id).join(', ')}: ${decided.reason}`)
    }
    if (s.accept.approval === 'operator' && !decided) return this.finish(record, 'held', 'verification passed; awaiting operator approval', s.id)
    return this.finish(record, 'succeeded', decided ? `accepted by ${decided.caller.operatorId}: ${decided.reason}` : `accepted on ${s.accept.requires.join(', ')}`)
  }

  /** The approval of an effect step that requires all of `verifyIds`, if any. */
  private effectDecisionOn(record: WorkRecord, spec: ResolvedSpec, verifyIds: string[]): Extract<WorkEvent, { type: 'decided' }> | undefined {
    for (const t of spec.steps) {
      if (!isEffectStep(t) || !verifyIds.every((id) => t.effect.requires.includes(id))) continue
      const found = this.decisionOf(record, t.id)
      if (found) return found
    }
    return undefined
  }

  /** The operator's approval of a step since it was last reset, if any. */
  private decisionOf(record: WorkRecord, stepId: string): Extract<WorkEvent, { type: 'decided' }> | undefined {
    if (record.state.steps[stepId]!.decision !== 'approved') return undefined
    const event = record.events.findLast((e) => e.type === 'decided' && e.stepId === stepId)
    return event?.type === 'decided' ? event : undefined
  }

  /**
   * Publish the exact subject the required verifiers passed, at most once per
   * operation: intent first, effect second, outcome third.
   */
  private async runEffect(record: WorkRecord, spec: ResolvedSpec, s: Extract<Step, { effect: unknown }>): Promise<Turn> {
    const { record: dispatched, attempt } = await this.dispatchEffect(record, spec, s)
    return this.attemptTurn(dispatched, attempt && (async () => {
      const applied = await this.executeEffect(attempt.provider, attempt.intent)
      return this.lane(() => this.observeEffect(record.id, attempt.provider, attempt.intent, applied))
    }))
  }

  /** In the lane: decide from the committed record and append the intent; `attempt` is absent when the step failed or is held instead. */
  private async dispatchEffect(record: WorkRecord, spec: ResolvedSpec, s: Extract<Step, { effect: unknown }>): Promise<{ record: WorkRecord; attempt?: { provider: EffectPort; intent: EffectIntent } }> {
    const subject = this.resolveRef(record, s.effect.subject)
    const decided = this.decisionOf(record, s.id)
    // ADR-0004 decision 12: only a pass on this exact subject allows the effect; the one exception is an inconclusive verdict (a check the base fails too, df-25) that a human approved.
    const notPass = s.effect.requires.map((stepId) => [stepId, this.verdictOf(record, spec, stepId)] as const).filter(([, verdict]) => verdict !== 'pass')
    const acceptedInconclusive = notPass.length > 0 && notPass.every(([, verdict]) => verdict === 'inconclusive')
    if (acceptedInconclusive && !decided) {
      return { record: await this.finish(record, 'held', `inconclusive verification needs an operator decision: ${notPass.map(([id]) => id).join(', ')}`, s.id) }
    }
    if (notPass.length && !acceptedInconclusive) {
      return { record: await this.finish(record, 'failed', `${s.id} needs a passing verdict on its subject: ${notPass.map(([id, v]) => `${id}=${v ?? 'missing'}`).join(', ')}`) }
    }
    const provider = this.capabilities.routeEffect(s.effect.capability).selected
    if (!provider) return { record: await this.finish(record, 'failed', `no enabled provider offers ${s.effect.capability} for step ${s.id}`) }
    const kind = this.specs.kindOf(subject)
    if (!kind || !provider.accepts.includes(kind)) return { record: await this.finish(record, 'failed', `${provider.ref} publishes ${provider.accepts.join(', ')}, not ${kind ?? 'a missing Artifact'}`) }
    const intent: EffectIntent = {
      operationId: `op:${createHash('sha256').update(`${record.id}\n${s.id}\n${subject}`).digest('hex')}`,
      workId: record.id, stepId: s.id, capability: s.effect.capability, subject, params: { ...s.effect.params }, required: this.requiredOf(record, s),
      ...(acceptedInconclusive ? { acceptedInconclusive: true } : {}),
    }
    const why = provider.approval(intent)
    if (why && !decided) return { record: await this.finish(record, 'held', `${s.id} awaits operator approval: ${why}`, s.id) }
    record = await this.append(record, {
      type: 'effect-intended', stepId: s.id, operationId: intent.operationId, capability: intent.capability, subject,
      params: intent.params, provider: { ref: provider.ref, version: provider.version },
    })
    return { record, attempt: { provider, intent } }
  }

  /**
   * Record a human operator's decision on held Work; an approval runs it on.
   * Agent callers are refused (ADR-0004 decision 3).
   */
  async decide(workId: string, decision: Approval, command?: Command, started?: () => void): Promise<WorkRecord> {
    if (decision.caller.type !== 'human') throw new WorkError('only a human operator approves; an agent caller cannot decide')
    const release = await this.enter(workId, command)
    try {
      const denied = await this.lane(async () => {
        const record = this.require(workId)
        const stepId = record.state.status === 'held' ? record.state.awaiting : undefined
        if (!stepId) throw new WorkError(`nothing awaits a decision on ${workId} (it is ${record.state.status})`)
        const decided = await this.append(record, { type: 'decided', caller: decision.caller, stepId, decision: decision.decision, reason: decision.reason })
        return decision.decision === 'denied' ? await this.finish(decided, 'failed', `${stepId} denied by ${decision.caller.operatorId}: ${decision.reason}`) : undefined
      })
      started?.()
      return denied ?? await this.drive(workId)
    } finally {
      this.leave(workId, release)
    }
  }

  private finish(record: WorkRecord, outcome: 'succeeded' | 'failed' | 'held', reason: string, awaiting?: string, satisfied?: { result: 'satisfied'; evidence: Record<string, string> }): Promise<WorkRecord> {
    const results: Record<string, string> = {}
    for (const [stepId, s] of Object.entries(record.state.steps)) {
      for (const [slot, id] of Object.entries(s.outputs)) results[`${stepId}.${slot}`] = id
    }
    for (const [name, id] of Object.entries(satisfied?.evidence ?? {})) if (id) results[name] = id
    return this.append(record, { type: 'terminal', outcome, reason, results, ...(satisfied ? { result: satisfied.result } : {}), ...(awaiting ? { awaiting } : {}) })
  }
}

/** Whether a step is done for the steps after it: it succeeded, or its condition was not met and it was skipped. */
function settled(record: WorkRecord, stepId: string): boolean {
  return record.state.steps[stepId]!.state === 'succeeded' || record.state.steps[stepId]!.state === 'skipped'
}

/** Why a ready step does not run: its `when` output was not written, or its `unless` output was; undefined when it runs. */
function skipReason(record: WorkRecord, s: Step): string | undefined {
  const { when, unless } = s as { when?: string; unless?: string }
  const written = (ref: string): boolean => {
    const names = ref.split('.')
    return !!record.state.steps[names.slice(1, -1).join('.')]?.outputs[names.at(-1)!]
  }
  if (when && !written(when)) return `${when} was not written`
  if (unless && written(unless)) return `${unless} was written`
  return undefined
}

/** Every step that depends, directly or not, on `stepId`, in spec order. */
function dependentsOf(spec: ResolvedSpec, stepId: string): string[] {
  const found = new Set<string>([stepId])
  for (const s of spec.steps) if ((s.dependsOn ?? []).some((d) => found.has(d))) found.add(s.id)
  found.delete(stepId)
  return spec.steps.map((s) => s.id).filter((id) => found.has(id))
}

function lastReason(record: WorkRecord, stepId: string): string {
  const event = record.events.findLast((e) => e.type === 'effect-observed' && e.stepId === stepId)
  return event?.type === 'effect-observed' ? event.reason : 'no observation'
}

/** Whether a later verify or effect step takes `$steps.<stepId>.<slot>` as its subject. */
function isJudged(spec: ResolvedSpec, stepId: string, slot: string): boolean {
  const ref = `$steps.${stepId}.${slot}`
  return spec.steps.some((t) => (isVerifyStep(t) && t.verify.subject === ref) || (isEffectStep(t) && t.effect.subject === ref))
}

function refsOf(s: Step): string[] {
  if (isWorkerStep(s)) return Object.values(s.inputs ?? {})
  if (isVerifyStep(s)) return [s.verify.subject, ...Object.values(s.verify.inputs ?? {})]
  if (isEffectStep(s)) return [s.effect.subject]
  return []
}

function pick(outputs: Record<string, string>, slots: readonly string[]): Record<string, string> {
  return Object.fromEntries(slots.map((slot) => [slot, outputs[slot]!]))
}
