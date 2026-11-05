/**
 * The Work Controller: one generic interpreter for every Workflow (ADR-0002
 * decision 3). It admits Work against the effective capabilities, pins the
 * resolved spec as an Artifact, and advances one step at a time, persisting a
 * `dispatched` event before calling a Worker or verifier and the observation
 * after. There is no domain-specific branch.
 *
 * Recovery: a step whose last attempt was dispatched but never observed lost
 * its process; it is recorded `attempt-lost` and dispatched again as a new
 * attempt with the same recorded inputs. Completed steps are never re-run.
 */
import { randomUUID } from 'node:crypto'
import { canonicalJson } from '@system/artifacts'
import { z } from 'zod'
import type { Verdict } from './kinds.ts'
import type { Capabilities, VerifyResult } from './registry.ts'
import { TERMINAL, fold, workRecordSchema, type Caller, type NewEvent, type WorkEvent, type WorkRecord, type WorkState } from './record.ts'
import { isVerifyStep, isWorkerStep, workflowSchema, type ResolvedSpec, type Step } from './workflow.ts'

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

/**
 * Cross-process control of one Work (one DSH host per Work at a time). Each
 * host caches records in memory, so only the host that holds a Work's lock
 * writes it; another process asks it to cancel through `requestCancel`.
 */
export interface HostControl {
  /** Take the Work's lock; throws when a live host already runs it. Returns the release. */
  acquire(workId: string): () => void
  /** Whether a live run holds the Work's lock: another process, or another call in this one. */
  heldElsewhere(workId: string): boolean
  requestCancel(workId: string, request: CancelRequest): void
  cancelRequest(workId: string): CancelRequest | undefined
  clearCancel(workId: string): void
}

export interface CancelRequest {
  reason: string
  caller: Caller
}

/** For a single process (tests): no other host exists. */
export class LocalControl implements HostControl {
  private readonly held = new Set<string>()
  private readonly cancels = new Map<string, CancelRequest>()

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

/** How often a running attempt checks for a cancel request. */
export const CANCEL_POLL_MS = 250

export class WorkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkError'
  }
}

export class WorkController {
  private readonly table: WorkTable
  private readonly specs: SpecStore
  private readonly capabilities: Capabilities
  private readonly control: HostControl
  private readonly now: () => string

  constructor(table: WorkTable, specs: SpecStore, capabilities: Capabilities, control: HostControl = new LocalControl(), now: () => string = () => new Date().toISOString()) {
    this.table = table
    this.specs = specs
    this.capabilities = capabilities
    this.control = control
    this.now = now
  }

  /** Pin the spec and create the Work record; nothing is dispatched yet. */
  async admit(admission: Admission): Promise<WorkRecord> {
    const usesInput = admission.spec.steps.some((s) => refsOf(s).includes('$work.input'))
    if (usesInput && !admission.input) throw new WorkError('the workflow uses $work.input, but no input Artifact was given')
    if (admission.input && !this.specs.exists(admission.input)) throw new WorkError(`input ${admission.input} is not a stored Artifact`)
    // Pin every verify step's criteria now: later edits to a repository or a verifier's defaults cannot change them.
    const criteria: Record<string, string> = {}
    for (const s of admission.spec.steps.filter(isVerifyStep)) {
      const verifier = this.capabilities.routeVerifier(s.verify.capability).selected
      if (!verifier) throw new WorkError(`no enabled verifier provides ${s.verify.capability}`)
      try {
        criteria[s.id] = await verifier.criteria({ capability: s.verify.capability, name: s.verify.criteria, input: admission.input, operatorId: admission.caller.operatorId })
      } catch (error) {
        throw new WorkError(`step ${s.id}: ${verifier.ref} cannot pin criteria ${s.verify.criteria}: ${(error as Error).message}`)
      }
      if (!this.specs.exists(criteria[s.id]!)) throw new WorkError(`step ${s.id}: ${verifier.ref} returned criteria ${criteria[s.id]} that is not stored`)
    }
    const specId = await this.specs.putSpec(admission.spec, admission.caller)
    const id = `work:${randomUUID()}`
    const admitted: WorkEvent = { type: 'admitted', seq: 0, at: this.now(), caller: admission.caller, specId, input: admission.input, criteria, source: admission.source }
    const record: WorkRecord = { id, events: [admitted], state: fold(admission.spec.steps.map((s) => s.id), [admitted]) }
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

  /** Advance until the Work is terminal, holding its lock. */
  async run(workId: string): Promise<WorkRecord> {
    const release = this.control.acquire(workId)
    try {
      let record = await this.recover(this.require(workId))
      while (!TERMINAL.has(record.state.status)) {
        const cancel = this.control.cancelRequest(workId)
        record = cancel ? await this.cancelled(record, cancel) : await this.step(record)
      }
      return record
    } finally {
      release()
    }
  }

  runningElsewhere(workId: string): boolean {
    return this.control.heldElsewhere(workId)
  }

  /**
   * Cancel Work. A live host running it is asked to stop its attempt (it
   * records the outcome itself); otherwise the outcome is recorded here.
   */
  async cancel(workId: string, request: CancelRequest): Promise<'requested' | WorkRecord> {
    const record = this.require(workId)
    if (TERMINAL.has(record.state.status)) throw new WorkError(`${workId} is already ${record.state.status}`)
    if (this.control.heldElsewhere(workId)) {
      this.control.requestCancel(workId, request)
      return 'requested'
    }
    const release = this.control.acquire(workId)
    try {
      return await this.cancelled(await this.recover(this.require(workId)), request)
    } finally {
      release()
    }
  }

  /**
   * Take over a failed or cancelled Worker step with a new attempt, optionally
   * only by `worker`. The new attempt gets the same recorded inputs plus, as
   * `previous`, the partial output the last attempt left. Then run.
   */
  async retry(workId: string, options: { worker?: string; step?: string; caller: Caller; reason: string }): Promise<WorkRecord> {
    const record = this.require(workId)
    if (!['failed', 'cancelled', 'held'].includes(record.state.status)) throw new WorkError(`only failed, cancelled or held Work is retried; ${workId} is ${record.state.status}`)
    if (options.worker && !this.capabilities.workerRefs().includes(options.worker)) throw new WorkError(`no enabled Worker ${options.worker}; enabled: ${this.capabilities.workerRefs().join(', ') || 'none'}`)
    const spec = this.specOf(record)
    const workerSteps = spec.steps.filter(isWorkerStep)
    const step = options.step
      ? workerSteps.find((s) => s.id === options.step)
      : workerSteps.find((s) => ['failed', 'cancelled', 'pending'].includes(record.state.steps[s.id]!.state) && (s.dependsOn ?? []).every((d) => record.state.steps[d]!.state === 'succeeded'))
    if (!step) throw new WorkError(options.step ? `${options.step} is not a Worker step of ${workId}` : `${workId} has no Worker step to take over; name one with --step`)
    if (!(step.dependsOn ?? []).every((d) => record.state.steps[d]!.state === 'succeeded')) throw new WorkError(`step ${step.id} depends on steps that have not succeeded`)
    const partial = Object.values(record.state.steps[step.id]!.partial ?? {})[0]
    const reset = [step.id, ...dependentsOf(spec, step.id)]
    const release = this.control.acquire(workId)
    try {
      this.control.clearCancel(workId)
      await this.append(record, { type: 'reopened', caller: options.caller, stepId: step.id, reason: options.reason, worker: options.worker, previous: partial, reset })
    } finally {
      release()
    }
    return this.run(workId)
  }

  private require(workId: string): WorkRecord {
    const record = this.table.get(workId)
    if (!record) throw new WorkError(`no Work ${workId}`)
    return record
  }

  private async append(record: WorkRecord, event: NewEvent): Promise<WorkRecord> {
    const stepIds = this.specOf(record).steps.map((s) => s.id)
    return this.table.update(record.id, (current) => {
      const next = { ...event, seq: current.events.length, at: this.now() } as WorkEvent
      const events = [...current.events, next]
      return { ...current, events, state: fold(stepIds, events) }
    })
  }

  /** Mark attempts that were dispatched but never observed as lost. */
  private async recover(record: WorkRecord): Promise<WorkRecord> {
    for (const [stepId, s] of Object.entries(record.state.steps)) {
      if (s.state !== 'running') continue
      const attemptId = s.attempts.at(-1)!
      record = await this.append(record, { type: 'attempt-lost', stepId, attemptId, reason: 'the host stopped before the attempt reported; it is dispatched again as a new attempt' })
    }
    return record
  }

  private async step(record: WorkRecord): Promise<WorkRecord> {
    const spec = this.specOf(record)
    const done = (stepId: string) => record.state.steps[stepId]!.state === 'succeeded'
    const failed = spec.steps.find((s) => ['failed', 'cancelled'].includes(record.state.steps[s.id]!.state))
    if (failed) return this.finish(record, 'failed', `step ${failed.id} ${record.state.steps[failed.id]!.state}`)
    const next = spec.steps.find((s) => record.state.steps[s.id]!.state === 'pending' && (s.dependsOn ?? []).every(done))
    if (!next) return this.finishWithoutAccept(record, spec)
    if (isWorkerStep(next)) return this.runWorker(record, next)
    if (isVerifyStep(next)) return this.runVerifier(record, next)
    return this.accept(record, next)
  }

  /** Resolve a reference to an exact Artifact ID from recorded state. */
  private resolveRef(record: WorkRecord, ref: string): string {
    if (ref === '$work.input') return record.state.input!
    const [, stepId, slot] = ref.split('.')
    const id = record.state.steps[stepId!]?.outputs[slot!]
    if (!id) throw new WorkError(`${ref} has no recorded Artifact`)
    return id
  }

  private async runWorker(record: WorkRecord, s: Extract<Step, { capabilities: string[] }>): Promise<WorkRecord> {
    const inputs = Object.fromEntries(Object.entries(s.inputs ?? {}).map(([name, ref]) => [name, this.resolveRef(record, ref)]))
    const reopened = record.events.findLast((e) => e.type === 'reopened' && e.stepId === s.id)
    const takeover = reopened?.type === 'reopened' ? reopened : undefined
    if (takeover?.previous) inputs.previous = takeover.previous
    const route = this.capabilities.routeWorker(s.capabilities, takeover?.worker)
    if (!route.selected) return this.finish(record, 'failed', `no enabled Worker ${takeover?.worker ? `${takeover.worker} ` : ''}provides ${s.capabilities.join(', ')} for step ${s.id}`)
    const attemptId = `attempt:${randomUUID()}`
    record = await this.append(record, {
      type: 'dispatched', stepId: s.id, attemptId, executor: 'worker', capability: s.capabilities.join(','),
      selected: route.selected.ref, candidates: route.candidates, inputs,
    })
    const abort = new AbortController()
    const poll = setInterval(() => { if (this.control.cancelRequest(record.id)) abort.abort() }, CANCEL_POLL_MS)
    // A poll never keeps the process alive by itself.
    poll.unref()
    let result
    try {
      result = await route.selected.run({ workId: record.id, attemptId, stepId: s.id, capabilities: s.capabilities, inputs, outputs: s.outputs, instructions: s.instructions, signal: abort.signal })
    } catch (error) {
      result = { status: abort.signal.aborted ? 'cancelled' as const : 'failed' as const, outputs: {}, reason: `the Worker threw: ${(error as Error).message}` }
    } finally {
      clearInterval(poll)
    }
    let { status, reason } = result
    if (abort.signal.aborted) status = 'cancelled'
    const outputs = status === 'succeeded' ? result.outputs : {}
    if (status === 'succeeded') {
      // A Worker's word is not its output: every declared slot must name a stored Artifact.
      const missing = s.outputs.filter((slot) => !outputs[slot] || !this.specs.exists(outputs[slot]))
      if (missing.length) [status, reason] = ['failed', `the Worker reported success without stored outputs ${missing.join(', ')}`]
    }
    const partial = Object.fromEntries(Object.entries(result.partial ?? {}).filter(([, id]) => this.specs.exists(id)))
    record = await this.append(record, {
      type: 'observed', stepId: s.id, attemptId, status, outputs: status === 'succeeded' ? pick(outputs, s.outputs) : {}, reason,
      usage: result.usage ? { state: 'observed', ...result.usage } : { state: 'unknown' },
      ...(Object.keys(partial).length ? { partial } : {}),
      ...(result.log && this.specs.exists(result.log) ? { log: result.log } : {}),
      ...(result.executor ? { worker: result.executor } : {}),
    })
    const cancel = this.control.cancelRequest(record.id)
    return status === 'cancelled' && cancel ? this.cancelled(record, cancel) : record
  }

  /** Record cancellation as terminal; a still-running step is marked lost first. */
  private async cancelled(record: WorkRecord, request: CancelRequest): Promise<WorkRecord> {
    record = await this.recover(record)
    const done = await this.append(record, { type: 'terminal', outcome: 'cancelled', reason: `cancelled by ${request.caller.type} ${request.caller.operatorId}: ${request.reason}`, results: {}, caller: request.caller })
    this.control.clearCancel(record.id)
    return done
  }

  private async runVerifier(record: WorkRecord, s: Extract<Step, { verify: unknown }>): Promise<WorkRecord> {
    const subject = this.resolveRef(record, s.verify.subject)
    const criteria = record.state.criteria[s.id]
    if (!criteria) return this.finish(record, 'failed', `step ${s.id} has no pinned criteria`)
    const route = this.capabilities.routeVerifier(s.verify.capability)
    if (!route.selected) return this.finish(record, 'failed', `no enabled verifier provides ${s.verify.capability} for step ${s.id}`)
    const verifier = route.selected
    const attemptId = `attempt:${randomUUID()}`
    record = await this.append(record, {
      type: 'dispatched', stepId: s.id, attemptId, executor: 'verifier', capability: s.verify.capability,
      selected: verifier.ref, candidates: route.candidates, inputs: { subject, criteria },
    })
    const kind = this.specs.kindOf(subject)
    let result: VerifyResult
    if (!kind || !verifier.accepts.includes(kind)) {
      result = { verdict: 'error', reason: `${verifier.ref} judges ${verifier.accepts.join(', ')}, not ${kind ?? 'a missing Artifact'}`, subject, criteria, evidence: [] }
    } else {
      try {
        result = await verifier.verify({ workId: record.id, attemptId, stepId: s.id, capability: s.verify.capability, subject, criteria })
      } catch (error) {
        result = { verdict: 'error', reason: `the verifier threw: ${(error as Error).message}`, subject, criteria, evidence: [] }
      }
    }
    const bound = this.bind(result, subject, criteria)
    const verdictId = await this.specs.putVerdict({
      subject, criteria, capability: s.verify.capability, verifier: { ref: verifier.ref, version: verifier.version },
      verdict: bound.verdict, reason: bound.reason, evidence: bound.evidence,
    })
    return this.append(record, {
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
    if (notPass.length) return this.finish(record, 'held', `inconclusive verification needs an operator decision: ${notPass.map(([id]) => id).join(', ')}`)
    if (s.accept.approval === 'operator') return this.finish(record, 'held', 'verification passed; awaiting operator approval')
    return this.finish(record, 'succeeded', `accepted on ${s.accept.requires.join(', ')}`)
  }

  private finish(record: WorkRecord, outcome: 'succeeded' | 'failed' | 'held', reason: string): Promise<WorkRecord> {
    const results: Record<string, string> = {}
    for (const [stepId, s] of Object.entries(record.state.steps)) {
      for (const [slot, id] of Object.entries(s.outputs)) results[`${stepId}.${slot}`] = id
    }
    return this.append(record, { type: 'terminal', outcome, reason, results })
  }
}

/** Every step that depends, directly or not, on `stepId`, in spec order. */
function dependentsOf(spec: ResolvedSpec, stepId: string): string[] {
  const found = new Set<string>([stepId])
  for (const s of spec.steps) if ((s.dependsOn ?? []).some((d) => found.has(d))) found.add(s.id)
  found.delete(stepId)
  return spec.steps.map((s) => s.id).filter((id) => found.has(id))
}

function refsOf(s: Step): string[] {
  if (isWorkerStep(s)) return Object.values(s.inputs ?? {})
  if (isVerifyStep(s)) return [s.verify.subject]
  return []
}

function pick(outputs: Record<string, string>, slots: readonly string[]): Record<string, string> {
  return Object.fromEntries(slots.map((slot) => [slot, outputs[slot]!]))
}
