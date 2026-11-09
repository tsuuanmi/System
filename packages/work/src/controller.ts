/**
 * The Work Controller: one generic interpreter for every Workflow (ADR-0002
 * decision 3). It admits Work against the effective capabilities, pins the
 * resolved spec as an Artifact, and advances one step at a time, persisting a
 * `dispatched` event before calling a Worker or verifier and the observation
 * after. Each attempt is three phases: dispatch and observe run in the commit
 * lane and read the latest committed record, execute runs outside it and
 * touches no Work state. There is no domain-specific branch.
 *
 * Scheduling (PROP-0004 C3): a drive dispatches every ready step (pending, all
 * `dependsOn` succeeded) whose Account has a free slot, and goes on as each
 * attempt reports. A Worker attempt holds a slot of its Account (see
 * `slots.ts`) from before `dispatched` until `observed`. Verifier and effect
 * steps take none. Ready steps
 * that find no slot wait in memory; a freed slot wakes the Works in admission
 * order, and each takes its steps in Workflow file order.
 *
 * Recovery: a step whose last attempt was dispatched but never observed lost
 * its process; it is recorded `attempt-lost`, and the next run dispatches it
 * again as a new attempt with the same recorded inputs. Completed steps are
 * never re-run.
 */
import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from '@system/artifacts'
import { z } from 'zod'
import { MemoryControl, type CancelRequest } from './control.ts'
import { WorkError } from './errors.ts'
import { overBudget, resolveGoal, spendOf, type GoalStore, type GoalView } from './goal.ts'
import { noLane, type Lane } from './lane.ts'
import { DEFAULT_STALL_MINUTES, LiveAttempts, type LiveAttempt } from './live.ts'
import type { Verdict } from './kinds.ts'
import { Slots, type LostAttempt } from './slots.ts'
import type { Capabilities, EffectIntent, EffectOutcome, EffectPort, Reconciled, VerifierPort, VerifyResult, WorkerPort, WorkerResult } from './registry.ts'
import { TERMINAL, fold, workRecordSchema, type Caller, type NewEvent, type Receipt, type WorkEvent, type WorkRecord, type WorkState } from './record.ts'
import { isEffectStep, isVerifyStep, isWorkerStep, stepSchema, type ResolvedSpec, type Step } from './workflow.ts'

/** The Work table: one key per Work, changed only by atomic `update`. */
export interface WorkTable {
  get(key: string): WorkRecord | undefined
  put(key: string, value: WorkRecord): Promise<void>
  update(key: string, fn: (current: WorkRecord) => WorkRecord): Promise<WorkRecord>
  keys(): IterableIterator<string>
}

/** The Artifact operations the controller needs. */
export interface SpecStore {
  putSpec(spec: ResolvedSpec, caller: Caller): Promise<string>
  getSpec(specId: string): ResolvedSpec | undefined
  exists(id: string): boolean
  /** The kind of a stored Artifact. */
  kindOf(id: string): string | undefined
  /** Store a `verdict@1` Artifact; returns its ID. */
  putVerdict(verdict: Verdict): Promise<string>
  /** Goals, when this store has them: a Host without them refuses a Work that names one. */
  goals?: GoalStore
}

/** How often a running attempt checks for a cancel request. */
const CANCEL_POLL_MS = 250

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
  /** The Goal to admit under: its budget must have room, and its context goes to the Task. */
  goal?: string
  /** Only this Worker may take the Work's Worker steps; it must be enabled and offer each step's capabilities. */
  worker?: string
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

export class WorkController {
  private readonly table: WorkTable
  private readonly specs: SpecStore
  private readonly capabilities: Capabilities
  private readonly control = new MemoryControl()
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
  /** The running Worker attempts' progress, in memory only. */
  private readonly running: LiveAttempts

  constructor(table: WorkTable, specs: SpecStore, capabilities: Capabilities, lane: Lane = noLane, slots: Slots = new Slots(capabilities), stallMinutes = DEFAULT_STALL_MINUTES) {
    this.table = table
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
    return this.running.of(workId)
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
    let input = admission.input
    if (admission.goal) {
      const { current, spend } = this.goalView(admission.goal)
      const used = overBudget(current.goal.budget, spend)
      if (used) throw new WorkError(`the budget of Goal ${current.id} is used up (${used}); a raise is a new Goal that supersedes it`)
      if (!input) throw new WorkError("a Goal's Work needs an input Task to carry the Goal's context")
      input = await this.specs.goals!.wrapTask(input, current.goal.context, admission.caller)
    }
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
    const specId = await this.specs.putSpec(admission.spec, admission.caller)
    const id = options.workId ?? `work:${randomUUID()}`
    const admitted: WorkEvent = { type: 'admitted', seq: 0, at: this.now(), caller: admission.caller, specId, input, ...(admission.goal ? { goal: admission.goal } : {}), ...(admission.worker ? { worker: admission.worker } : {}), criteria, verifiers, source: admission.source }
    const record: WorkRecord = {
      id, events: [admitted], state: fold(admission.spec.steps.map((s) => s.id), [admitted]),
      ...(options.command ? { receipts: [{ commandId: options.command.id, args: options.command.args, result: { workId: id, status: 'running' } }] } : {}),
    }
    await this.table.put(id, workRecordSchema.parse(record))
    this.changed(record)
    return record
  }

  get(workId: string): WorkRecord | undefined {
    return this.table.get(workId)
  }

  /** A Goal, its newest version and the spend of its chain, folded from the Works recorded now. */
  goalView(goalId: string): GoalView {
    if (!this.specs.goals) throw new WorkError('this Host has no Goals')
    const { view, chain } = resolveGoal(this.specs.goals, goalId)
    return { ...view, spend: spendOf(this.list(), chain) }
  }

  /** The Goal and every Goal in its supersedes chain, as far back and forward as the chain goes. */
  goalChain(goalId: string): ReadonlySet<string> {
    if (!this.specs.goals) throw new WorkError('this Host has no Goals')
    return resolveGoal(this.specs.goals, goalId).chain
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

  /** In the lane, take the Work's lock, so runs and cancels reach it in the order they were asked. */
  private enter(workId: string, command?: Command): Promise<() => void> {
    return this.lane(async () => {
      const release = this.control.acquire(workId)
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
    const cancel = this.control.cancelRequest(workId)
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
    return this.control.heldElsewhere(workId)
  }

  /**
   * Cancel Work. A live host running it is asked to stop its attempt (it
   * records the outcome itself); otherwise the outcome is recorded here.
   */
  async cancel(workId: string, request: CancelRequest, command?: Command): Promise<'requested' | WorkRecord> {
    return this.lane(async () => {
      const record = this.require(workId)
      if (TERMINAL.has(record.state.status)) throw new WorkError(`${workId} is already ${record.state.status}`)
      if (this.control.heldElsewhere(workId)) {
        this.control.requestCancel(workId, request)
        this.notify()
        // The run that holds the Work records the cancellation; its terminal event carries this receipt too.
        if (command) this.expect(workId, command)
        return 'requested'
      }
      const release = this.control.acquire(workId)
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
      : spec.steps.filter(isWorkerStep).find((s) => ['failed', 'cancelled', 'pending'].includes(record.state.steps[s.id]!.state) && (s.dependsOn ?? []).every((d) => record.state.steps[d]!.state === 'succeeded'))
    if (!step) throw new WorkError(options.step ? `${options.step} is not a Worker, verify or effect step of ${workId}` : `${workId} has no Worker step to take over; name one with --step`)
    // Choosing among runs of a check would let an agent keep the lucky one: verifying again is the operator's.
    if (isVerifyStep(step) && options.caller.type !== 'human') throw new WorkError(`only a human verifies again; an ${options.caller.type} records a decision and tells the operator`)
    if (!isWorkerStep(step) && options.worker) throw new WorkError(`${step.id} is ${isVerifyStep(step) ? 'a verify' : 'an effect'} step; --worker names Workers only`)
    if (!(step.dependsOn ?? []).every((d) => record.state.steps[d]!.state === 'succeeded')) throw new WorkError(`step ${step.id} depends on steps that have not succeeded`)
    const partial = Object.values(record.state.steps[step.id]!.partial ?? {})[0]
    const reset = [step.id, ...dependentsOf(spec, step.id)]
    this.control.clearCancel(workId)
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
    // A Worker attempt's process may still run: it keeps its Account's slot (over the limit if need be) until settled. A verifier takes no slot.
    for (const attempt of lost) {
      const dispatched = record.events.findLast((e) => e.type === 'dispatched' && e.attemptId === attempt.attemptId)
      if (dispatched?.type !== 'dispatched' || dispatched.executor !== 'worker') continue
      this.slots.hold(dispatched.selected, attempt)
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
    return { operationId, workId: record.id, stepId: event.stepId, capability: event.capability, subject: event.subject, params: event.params, required: step && isEffectStep(step) ? this.requiredOf(record, step) : [] }
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
    return this.append(record, { type: 'effect-observed', stepId: intent.stepId, operationId: intent.operationId, state: applied.state, reason: applied.reason, detail: applied.detail })
  }

  /** In the lane: dispatch every ready step that can start now, in Workflow file order. */
  private async step(record: WorkRecord, busy: boolean): Promise<Turn> {
    const spec = this.specOf(record)
    const epoch = this.epoch
    const done = (stepId: string) => record.state.steps[stepId]!.state === 'succeeded'
    const failed = spec.steps.find((s) => ['failed', 'cancelled'].includes(record.state.steps[s.id]!.state))
    // A failed step fails the Work once the attempts in flight have reported.
    if (failed && busy) return { record, settles: [], waiting: true, epoch }
    if (failed) return { record: await this.finish(record, 'failed', `step ${failed.id} ${record.state.steps[failed.id]!.state}`), settles: [], epoch }
    const ready = spec.steps.filter((s) => record.state.steps[s.id]!.state === 'pending' && (s.dependsOn ?? []).every(done))
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
            return await this.lane(() => this.observeWorker(attempt, execution))
          } finally {
            this.slots.release(attempt.worker.ref, attempt.attemptId)
          }
        }))
      } else if (isVerifyStep(next)) {
        turn = await this.runVerifier(record, next)
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
    const admitted = record.events[0]
    const only = takeover?.worker ?? (admitted?.type === 'admitted' ? admitted.worker : undefined)
    const route = this.capabilities.routeWorker(s.capabilities, only)
    if (!route.selected) return { record: await this.finish(record, 'failed', `no enabled Worker ${only ? `${only} ` : ''}provides ${s.capabilities.join(', ')} for step ${s.id}`) }
    const attemptId = `attempt:${randomUUID()}`
    if (!this.slots.reserve(route.selected, attemptId)) return { record, blocked: true }
    try {
      record = await this.append(record, {
        type: 'dispatched', stepId: s.id, attemptId, executor: 'worker', capability: s.capabilities.join(','),
        selected: route.selected.ref, candidates: route.candidates, inputs,
      })
    } catch (error) {
      this.slots.release(route.selected.ref, attemptId)
      throw error
    }
    return { record, attempt: { workId: record.id, attemptId, step: s, worker: route.selected, inputs } }
  }

  /** Outside the lane: run the Worker, touching no Work state. */
  private async executeWorker(attempt: WorkerAttempt): Promise<WorkerExecution> {
    const { workId, attemptId, step: s, inputs } = attempt
    const abort = new AbortController()
    const poll = setInterval(() => { if (this.control.cancelRequest(workId)) abort.abort() }, CANCEL_POLL_MS)
    // A poll never keeps the process alive by itself.
    poll.unref()
    const progress = this.running.start({ workId, stepId: s.id, attemptId, worker: attempt.worker.ref })
    try {
      return { result: await attempt.worker.run({ workId, attemptId, stepId: s.id, capabilities: s.capabilities, inputs, outputs: s.outputs, instructions: s.instructions, signal: abort.signal, progress }), aborted: abort.signal.aborted }
    } catch (error) {
      return { result: { status: abort.signal.aborted ? 'cancelled' : 'failed', outputs: {}, reason: `the Worker threw: ${(error as Error).message}` }, aborted: abort.signal.aborted }
    } finally {
      clearInterval(poll)
      this.running.end(attemptId)
    }
  }

  /** In the lane: read the committed record again and append the outcome. */
  private async observeWorker(attempt: WorkerAttempt, { result, aborted }: WorkerExecution): Promise<WorkRecord> {
    const { workId, attemptId, step: s } = attempt
    let { status, reason } = result
    if (aborted) status = 'cancelled'
    const outputs = status === 'succeeded' ? result.outputs : {}
    if (status === 'succeeded') {
      // A Worker's word is not its output: every declared slot must name a stored Artifact.
      const missing = s.outputs.filter((slot) => !outputs[slot] || !this.specs.exists(outputs[slot]))
      if (missing.length) [status, reason] = ['failed', `the Worker reported success without stored outputs ${missing.join(', ')}`]
    }
    const partial = Object.fromEntries(Object.entries(result.partial ?? {}).filter(([, id]) => this.specs.exists(id)))
    // A cancel request is recorded by the drive, once every attempt of the Work has reported.
    return this.append(this.require(workId), {
      type: 'observed', stepId: s.id, attemptId, status, outputs: status === 'succeeded' ? pick(outputs, s.outputs) : {}, reason,
      usage: result.usage ? { state: 'observed', ...result.usage } : { state: 'unknown' },
      ...(Object.keys(partial).length ? { partial } : {}),
      ...(result.log && this.specs.exists(result.log) ? { log: result.log } : {}),
      ...(result.executor ? { worker: result.executor } : {}),
    })
  }

  /** Record cancellation as terminal; a still-running step is marked lost first. */
  private async cancelled(record: WorkRecord, request: CancelRequest): Promise<WorkRecord> {
    record = await this.recover(record, { resumeEffects: false })
    const done = await this.append(record, { type: 'terminal', outcome: 'cancelled', reason: `cancelled by ${request.caller.type} ${request.caller.operatorId}: ${request.reason}`, results: {}, caller: request.caller })
    this.control.clearCancel(record.id)
    return done
  }

  private async runVerifier(record: WorkRecord, s: Extract<Step, { verify: unknown }>): Promise<Turn> {
    const { record: dispatched, attempt } = await this.dispatchVerifier(record, s)
    return this.attemptTurn(dispatched, attempt && (async () => {
      const result = await this.executeVerifier(attempt)
      return this.lane(() => this.observeVerifier(attempt, result))
    }))
  }

  /** In the lane: decide from the committed record and append `dispatched`; `attempt` is absent when the step failed instead. */
  private async dispatchVerifier(record: WorkRecord, s: Extract<Step, { verify: unknown }>): Promise<{ record: WorkRecord; attempt?: VerifierAttempt }> {
    const subject = this.resolveRef(record, s.verify.subject)
    const inputs = Object.fromEntries(Object.entries(s.verify.inputs ?? {}).map(([name, ref]) => [name, this.resolveRef(record, ref)]))
    const criteria = record.state.criteria[s.id]
    if (!criteria) return { record: await this.finish(record, 'failed', `step ${s.id} has no pinned criteria`) }
    const route = this.capabilities.routeVerifier(s.verify.capability)
    if (!route.selected) return { record: await this.finish(record, 'failed', `no enabled verifier provides ${s.verify.capability} for step ${s.id}`) }
    const verifier = route.selected
    const attemptId = `attempt:${randomUUID()}`
    const kind = this.specs.kindOf(subject)
    const admitted = record.events[0]
    const pinned = admitted?.type === 'admitted' ? admitted.verifiers?.[s.id] : undefined
    let refusal: string | undefined
    if (pinned && (pinned.ref !== verifier.ref || pinned.version !== verifier.version)) refusal = `pinned ${pinned.ref}@${pinned.version} at admission; ${verifier.ref}@${verifier.version} is enabled now`
    else if (!kind || !verifier.accepts.includes(kind)) refusal = `${verifier.ref} judges ${verifier.accepts.join(', ')}, not ${kind ?? 'a missing Artifact'}`
    record = await this.append(record, {
      type: 'dispatched', stepId: s.id, attemptId, executor: 'verifier', capability: s.verify.capability,
      selected: verifier.ref, candidates: route.candidates, inputs: { ...inputs, subject, criteria },
    })
    return { record, attempt: { workId: record.id, attemptId, step: s, verifier, subject, criteria, inputs, refusal } }
  }

  /** Outside the lane: ask the verifier, touching no Work state. */
  private async executeVerifier({ workId, attemptId, step: s, verifier, subject, criteria, inputs, refusal }: VerifierAttempt): Promise<VerifyResult> {
    if (refusal) return { verdict: 'error', reason: refusal, subject, criteria, evidence: [] }
    try {
      return await verifier.verify({ workId, attemptId, stepId: s.id, capability: s.verify.capability, subject, criteria, ...(Object.keys(inputs).length ? { inputs } : {}) })
    } catch (error) {
      return { verdict: 'error', reason: `the verifier threw: ${(error as Error).message}`, subject, criteria, evidence: [] }
    }
  }

  /** In the lane: read the committed record again and append the verdict. */
  private async observeVerifier({ workId, attemptId, step: s, verifier, subject, criteria }: VerifierAttempt, result: VerifyResult): Promise<WorkRecord> {
    const bound = this.bind(result, subject, criteria)
    const verdictId = await this.specs.putVerdict({
      subject, criteria, capability: s.verify.capability, verifier: { ref: verifier.ref, version: verifier.version },
      verdict: bound.verdict, reason: bound.reason, evidence: bound.evidence,
    })
    return this.append(this.require(workId), {
      type: 'verified', stepId: s.id, attemptId, subject, criteria,
      verdict: bound.verdict, reason: bound.reason, verdictId, evidence: bound.evidence,
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
    const verdicts = spec.steps.filter(isVerifyStep).map((s) => [s.id, this.verdictOf(record, spec, s.id)] as const)
    const bad = verdicts.filter(([, verdict]) => verdict !== 'pass' && verdict !== 'inconclusive')
    if (bad.length) return this.finish(record, 'failed', `verification did not pass: ${bad.map(([id, v]) => `${id}=${v ?? 'missing'}`).join(', ')}`)
    const unsure = verdicts.filter(([, verdict]) => verdict === 'inconclusive')
    if (unsure.length) return this.finish(record, 'held', `inconclusive verification needs an operator decision: ${unsure.map(([id]) => id).join(', ')}`)
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
    const decided = this.decisionOf(record, s.id)
    if (notPass.length) {
      if (!decided) return this.finish(record, 'held', `inconclusive verification needs an operator decision: ${notPass.map(([id]) => id).join(', ')}`, s.id)
      return this.finish(record, 'succeeded', `accepted by ${decided.caller.operatorId} despite inconclusive ${notPass.map(([id]) => id).join(', ')}: ${decided.reason}`)
    }
    if (s.accept.approval === 'operator' && !decided) return this.finish(record, 'held', 'verification passed; awaiting operator approval', s.id)
    return this.finish(record, 'succeeded', decided ? `accepted by ${decided.caller.operatorId}: ${decided.reason}` : `accepted on ${s.accept.requires.join(', ')}`)
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
    // ADR-0004 decision 12: only a pass on this exact subject allows the effect; no decision overrides it.
    const notPass = s.effect.requires.map((stepId) => [stepId, this.verdictOf(record, spec, stepId)] as const).filter(([, verdict]) => verdict !== 'pass')
    if (notPass.length) {
      return { record: await this.finish(record, 'failed', `${s.id} needs a passing verdict on its subject: ${notPass.map(([id, v]) => `${id}=${v ?? 'missing'}`).join(', ')}`) }
    }
    const provider = this.capabilities.routeEffect(s.effect.capability).selected
    if (!provider) return { record: await this.finish(record, 'failed', `no enabled provider offers ${s.effect.capability} for step ${s.id}`) }
    const kind = this.specs.kindOf(subject)
    if (!kind || !provider.accepts.includes(kind)) return { record: await this.finish(record, 'failed', `${provider.ref} publishes ${provider.accepts.join(', ')}, not ${kind ?? 'a missing Artifact'}`) }
    const intent: EffectIntent = {
      operationId: `op:${createHash('sha256').update(`${record.id}\n${s.id}\n${subject}`).digest('hex')}`,
      workId: record.id, stepId: s.id, capability: s.effect.capability, subject, params: { ...s.effect.params }, required: this.requiredOf(record, s),
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

  private finish(record: WorkRecord, outcome: 'succeeded' | 'failed' | 'held', reason: string, awaiting?: string): Promise<WorkRecord> {
    const results: Record<string, string> = {}
    for (const [stepId, s] of Object.entries(record.state.steps)) {
      for (const [slot, id] of Object.entries(s.outputs)) results[`${stepId}.${slot}`] = id
    }
    return this.append(record, { type: 'terminal', outcome, reason, results, ...(awaiting ? { awaiting } : {}) })
  }
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

function refsOf(s: Step): string[] {
  if (isWorkerStep(s)) return Object.values(s.inputs ?? {})
  if (isVerifyStep(s)) return [s.verify.subject, ...Object.values(s.verify.inputs ?? {})]
  if (isEffectStep(s)) return [s.effect.subject]
  return []
}

function pick(outputs: Record<string, string>, slots: readonly string[]): Record<string, string> {
  return Object.fromEntries(slots.map((slot) => [slot, outputs[slot]!]))
}
