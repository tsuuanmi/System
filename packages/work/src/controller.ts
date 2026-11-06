/**
 * The Work Controller: one generic interpreter for every Workflow (ADR-0002
 * decision 3). It admits Work against the effective capabilities, pins the
 * resolved spec as an Artifact, and advances one step at a time, persisting a
 * `dispatched` event before calling a Worker or verifier and the observation
 * after. Each attempt is three phases: dispatch and observe run in the commit
 * lane and read the latest committed record, execute runs outside it and
 * touches no Work state. There is no domain-specific branch.
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
import { noLane, type Lane } from './lane.ts'
import type { Verdict } from './kinds.ts'
import type { Capabilities, EffectIntent, EffectOutcome, EffectPort, Reconciled, VerifierPort, VerifyResult, WorkerPort, WorkerResult } from './registry.ts'
import { TERMINAL, fold, workRecordSchema, type Caller, type NewEvent, type Receipt, type WorkEvent, type WorkRecord, type WorkState } from './record.ts'
import { isEffectStep, isVerifyStep, isWorkerStep, workflowSchema, type ResolvedSpec, type Step } from './workflow.ts'

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
}

/** How often a running attempt checks for a cancel request. */
const CANCEL_POLL_MS = 250

export const SPEC_KIND = 'workflow-spec'
export const SPEC_SCHEMA_VERSION = 1

/** The zod schema of a resolved spec, for the `workflow-spec@1` Artifact kind. */
export const resolvedSpecSchema = z.object({
  workflow: z.object({ id: z.string(), version: z.number().int().positive() }).strict(),
  steps: workflowSchema.shape.steps,
}).strict()

export interface Admission {
  spec: ResolvedSpec
  input?: string
  caller: Caller
  source: { kind: 'workflow-file' | 'direct-task'; path?: string; fileHash?: string }
}

/** A command that is to leave a receipt in the Work it changes: its client ID and the hash of its arguments. */
export interface Command {
  id: string
  args: string
}

/** What one turn of a drive decided: the record now, and, when an attempt was dispatched, how to finish it. */
interface Turn {
  record: WorkRecord
  /** Execute outside the lane, then observe in it. */
  settle?: () => Promise<WorkRecord>
}

/** An attempt that was dispatched and never observed. */
export interface LostAttempt {
  workId: string
  stepId: string
  attemptId: string
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
  refusal?: string
}

export class WorkController {
  private readonly table: WorkTable
  private readonly specs: SpecStore
  private readonly capabilities: Capabilities
  private readonly control = new MemoryControl()
  private readonly lane: Lane
  /** Commands whose receipt the next `terminal` event of a Work carries. */
  private readonly expected = new Map<string, Receipt[]>()

  constructor(table: WorkTable, specs: SpecStore, capabilities: Capabilities, lane: Lane = noLane) {
    this.table = table
    this.specs = specs
    this.capabilities = capabilities
    this.lane = lane
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
    const admitted: WorkEvent = { type: 'admitted', seq: 0, at: this.now(), caller: admission.caller, specId, input: admission.input, criteria, verifiers, source: admission.source }
    const record: WorkRecord = {
      id, events: [admitted], state: fold(admission.spec.steps.map((s) => s.id), [admitted]),
      ...(options.command ? { receipts: [{ commandId: options.command.id, args: options.command.args, result: { workId: id, status: 'running' } }] } : {}),
    }
    await this.table.put(id, workRecordSchema.parse(record))
    return record
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
   * attempt runs outside it and comes back in to be observed.
   */
  private async drive(workId: string): Promise<WorkRecord> {
    let record = await this.lane(() => this.recover(this.require(workId)))
    while (!TERMINAL.has(record.state.status)) {
      const turn = await this.lane(() => this.advance(workId))
      record = turn.settle ? await turn.settle() : turn.record
    }
    return record
  }

  private async advance(workId: string): Promise<Turn> {
    const record = this.require(workId)
    const cancel = this.control.cancelRequest(workId)
    const unknown = Object.values(record.state.effects).find((e) => e.state === 'unknown')
    if (cancel) return { record: await this.cancelled(record, cancel) }
    if (unknown) return { record: await this.finish(record, 'held', `the outcome of ${unknown.stepId} is unknown: ${lastReason(record, unknown.stepId)}; check the remote, then run the Work again`) }
    return this.step(record)
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
   * `previous`, the partial output the last attempt left. Then run.
   */
  async retry(workId: string, options: { worker?: string; step?: string; caller: Caller; reason: string }, command?: Command, started?: () => void): Promise<WorkRecord> {
    const release = await this.enter(workId, command)
    try {
      await this.lane(() => this.reopen(workId, options))
      started?.()
      return await this.drive(workId)
    } finally {
      this.leave(workId, release)
    }
  }

  private async reopen(workId: string, options: { worker?: string; step?: string; caller: Caller; reason: string }): Promise<void> {
    const record = this.require(workId)
    if (!['failed', 'cancelled', 'held'].includes(record.state.status)) throw new WorkError(`only failed, cancelled or held Work is retried; ${workId} is ${record.state.status}`)
    if (options.worker && !this.capabilities.workerRefs().includes(options.worker)) throw new WorkError(`no enabled Worker ${options.worker}; enabled: ${this.capabilities.workerRefs().join(', ') || 'none'}`)
    const spec = this.specOf(record)
    const step = options.step
      ? spec.steps.find((s) => s.id === options.step && (isWorkerStep(s) || isEffectStep(s)))
      : spec.steps.filter(isWorkerStep).find((s) => ['failed', 'cancelled', 'pending'].includes(record.state.steps[s.id]!.state) && (s.dependsOn ?? []).every((d) => record.state.steps[d]!.state === 'succeeded'))
    if (!step) throw new WorkError(options.step ? `${options.step} is not a Worker or effect step of ${workId}` : `${workId} has no Worker step to take over; name one with --step`)
    if (isEffectStep(step) && options.worker) throw new WorkError(`${step.id} is an effect step; --worker names Workers only`)
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
    return this.table.update(record.id, (current) => {
      const next = { ...event, seq: current.events.length, at: this.now() } as WorkEvent
      const events = [...current.events, next]
      return { ...current, events, state: fold(stepIds, events), ...(receipts.length ? { receipts: [...(current.receipts ?? []), ...receipts] } : {}) }
    })
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
    return { operationId, workId: record.id, stepId: event.stepId, capability: event.capability, subject: event.subject, params: event.params }
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

  private async step(record: WorkRecord): Promise<Turn> {
    const spec = this.specOf(record)
    const done = (stepId: string) => record.state.steps[stepId]!.state === 'succeeded'
    const failed = spec.steps.find((s) => ['failed', 'cancelled'].includes(record.state.steps[s.id]!.state))
    if (failed) return { record: await this.finish(record, 'failed', `step ${failed.id} ${record.state.steps[failed.id]!.state}`) }
    const next = spec.steps.find((s) => record.state.steps[s.id]!.state === 'pending' && (s.dependsOn ?? []).every(done))
    if (!next) return { record: await this.finishWithoutAccept(record, spec) }
    if (isWorkerStep(next)) return this.runWorker(record, next)
    if (isVerifyStep(next)) return this.runVerifier(record, next)
    if (isEffectStep(next)) return this.runEffect(record, spec, next)
    return { record: await this.accept(record, next) }
  }

  /** Resolve a reference to an exact Artifact ID from recorded state. */
  private resolveRef(record: WorkRecord, ref: string): string {
    if (ref === '$work.input') return record.state.input!
    const [, stepId, slot] = ref.split('.')
    const id = record.state.steps[stepId!]?.outputs[slot!]
    if (!id) throw new WorkError(`${ref} has no recorded Artifact`)
    return id
  }

  private async runWorker(record: WorkRecord, s: Extract<Step, { capabilities: string[] }>): Promise<Turn> {
    const { record: dispatched, attempt } = await this.dispatchWorker(record, s)
    if (!attempt) return { record: dispatched }
    return { record: dispatched, settle: async () => {
      const execution = await this.executeWorker(attempt)
      return this.lane(() => this.observeWorker(attempt, execution))
    } }
  }

  /** In the lane: decide from the committed record and append `dispatched`; `attempt` is absent when the step failed instead. */
  private async dispatchWorker(record: WorkRecord, s: Extract<Step, { capabilities: string[] }>): Promise<{ record: WorkRecord; attempt?: WorkerAttempt }> {
    const inputs = Object.fromEntries(Object.entries(s.inputs ?? {}).map(([name, ref]) => [name, this.resolveRef(record, ref)]))
    const reopened = record.events.findLast((e) => e.type === 'reopened' && e.stepId === s.id)
    const takeover = reopened?.type === 'reopened' ? reopened : undefined
    if (takeover?.previous) inputs.previous = takeover.previous
    const route = this.capabilities.routeWorker(s.capabilities, takeover?.worker)
    if (!route.selected) return { record: await this.finish(record, 'failed', `no enabled Worker ${takeover?.worker ? `${takeover.worker} ` : ''}provides ${s.capabilities.join(', ')} for step ${s.id}`) }
    const attemptId = `attempt:${randomUUID()}`
    record = await this.append(record, {
      type: 'dispatched', stepId: s.id, attemptId, executor: 'worker', capability: s.capabilities.join(','),
      selected: route.selected.ref, candidates: route.candidates, inputs,
    })
    return { record, attempt: { workId: record.id, attemptId, step: s, worker: route.selected, inputs } }
  }

  /** Outside the lane: run the Worker, touching no Work state. */
  private async executeWorker(attempt: WorkerAttempt): Promise<WorkerExecution> {
    const { workId, attemptId, step: s, inputs } = attempt
    const abort = new AbortController()
    const poll = setInterval(() => { if (this.control.cancelRequest(workId)) abort.abort() }, CANCEL_POLL_MS)
    // A poll never keeps the process alive by itself.
    poll.unref()
    try {
      return { result: await attempt.worker.run({ workId, attemptId, stepId: s.id, capabilities: s.capabilities, inputs, outputs: s.outputs, instructions: s.instructions, signal: abort.signal }), aborted: abort.signal.aborted }
    } catch (error) {
      return { result: { status: abort.signal.aborted ? 'cancelled' : 'failed', outputs: {}, reason: `the Worker threw: ${(error as Error).message}` }, aborted: abort.signal.aborted }
    } finally {
      clearInterval(poll)
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
    const record = await this.append(this.require(workId), {
      type: 'observed', stepId: s.id, attemptId, status, outputs: status === 'succeeded' ? pick(outputs, s.outputs) : {}, reason,
      usage: result.usage ? { state: 'observed', ...result.usage } : { state: 'unknown' },
      ...(Object.keys(partial).length ? { partial } : {}),
      ...(result.log && this.specs.exists(result.log) ? { log: result.log } : {}),
      ...(result.executor ? { worker: result.executor } : {}),
    })
    const cancel = this.control.cancelRequest(workId)
    return status === 'cancelled' && cancel ? this.cancelled(record, cancel) : record
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
    if (!attempt) return { record: dispatched }
    return { record: dispatched, settle: async () => {
      const result = await this.executeVerifier(attempt)
      return this.lane(() => this.observeVerifier(attempt, result))
    } }
  }

  /** In the lane: decide from the committed record and append `dispatched`; `attempt` is absent when the step failed instead. */
  private async dispatchVerifier(record: WorkRecord, s: Extract<Step, { verify: unknown }>): Promise<{ record: WorkRecord; attempt?: VerifierAttempt }> {
    const subject = this.resolveRef(record, s.verify.subject)
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
      selected: verifier.ref, candidates: route.candidates, inputs: { subject, criteria },
    })
    return { record, attempt: { workId: record.id, attemptId, step: s, verifier, subject, criteria, refusal } }
  }

  /** Outside the lane: ask the verifier, touching no Work state. */
  private async executeVerifier({ workId, attemptId, step: s, verifier, subject, criteria, refusal }: VerifierAttempt): Promise<VerifyResult> {
    if (refusal) return { verdict: 'error', reason: refusal, subject, criteria, evidence: [] }
    try {
      return await verifier.verify({ workId, attemptId, stepId: s.id, capability: s.verify.capability, subject, criteria })
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
    if (!attempt) return { record: dispatched }
    const { provider, intent } = attempt
    return { record: dispatched, settle: async () => {
      const applied = await this.executeEffect(provider, intent)
      return this.lane(() => this.observeEffect(record.id, provider, intent, applied))
    } }
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
      workId: record.id, stepId: s.id, capability: s.effect.capability, subject, params: { ...s.effect.params },
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
  async decide(workId: string, decision: { decision: 'approved' | 'denied'; caller: Caller; reason: string }, command?: Command, started?: () => void): Promise<WorkRecord> {
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
  if (isVerifyStep(s)) return [s.verify.subject]
  if (isEffectStep(s)) return [s.effect.subject]
  return []
}

function pick(outputs: Record<string, string>, slots: readonly string[]): Record<string, string> {
  return Object.fromEntries(slots.map((slot) => [slot, outputs[slot]!]))
}
