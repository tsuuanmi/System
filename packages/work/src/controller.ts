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
import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from '@system/artifacts'
import { z } from 'zod'
import { LocalControl, type CancelRequest, type HostControl } from './control.ts'
import { WorkError } from './errors.ts'
import type { Verdict } from './kinds.ts'
import type { Capabilities, EffectIntent, EffectOutcome, EffectPort, Reconciled, VerifyResult } from './registry.ts'
import { TERMINAL, fold, workRecordSchema, type Caller, type NewEvent, type WorkEvent, type WorkRecord, type WorkState } from './record.ts'
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
export const CANCEL_POLL_MS = 250

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
        const unknown = Object.values(record.state.effects).find((e) => e.state === 'unknown')
        if (cancel) record = await this.cancelled(record, cancel)
        else if (unknown) record = await this.finish(record, 'held', `the outcome of ${unknown.stepId} is unknown: ${lastReason(record, unknown.stepId)}; check the remote, then run the Work again`)
        else record = await this.step(record)
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
  private async recover(record: WorkRecord, { resumeEffects = true } = {}): Promise<WorkRecord> {
    const pendingEffects = new Set(Object.values(record.state.effects).filter((e) => e.state === 'intended' || e.state === 'unknown').map((e) => e.stepId))
    for (const [stepId, s] of Object.entries(record.state.steps)) {
      if (s.state !== 'running' || pendingEffects.has(stepId)) continue
      const attemptId = s.attempts.at(-1)!
      record = await this.append(record, { type: 'attempt-lost', stepId, attemptId, reason: 'the host stopped before the attempt reported; it is dispatched again as a new attempt' })
    }
    // An effect whose outcome was not recorded is never applied again blindly: reconcile first.
    for (const [operationId, effect] of Object.entries(record.state.effects)) {
      if (effect.state !== 'intended' && effect.state !== 'unknown') continue
      const intent = this.intentOf(record, operationId)
      const provider = this.capabilities.routeEffect(intent.capability).selected
      if (!provider) {
        record = await this.append(record, { type: 'effect-observed', stepId: effect.stepId, operationId, state: 'unknown', reason: `no enabled provider of ${intent.capability} can reconcile it` })
        continue
      }
      record = await this.reconcile(record, provider, intent, resumeEffects ? 'apply-if-absent' : 'record-only')
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

  private async applyEffect(record: WorkRecord, provider: EffectPort, intent: EffectIntent): Promise<WorkRecord> {
    let outcome: EffectOutcome
    try {
      outcome = await provider.apply(intent)
    } catch (error) {
      // The remote may or may not have changed: read it, and never retry here.
      const after = await this.reconcile(record, provider, intent, 'record-only')
      const effect = after.state.effects[intent.operationId]!
      if (effect.state === 'absent') return this.finish(after, 'failed', `${intent.stepId} failed: ${(error as Error).message}; the remote shows nothing published`)
      return after
    }
    return this.append(record, { type: 'effect-observed', stepId: intent.stepId, operationId: intent.operationId, state: outcome.state, reason: outcome.reason, detail: outcome.detail })
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
    if (isEffectStep(next)) return this.runEffect(record, spec, next)
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
    record = await this.recover(record, { resumeEffects: false })
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
  private async runEffect(record: WorkRecord, spec: ResolvedSpec, s: Extract<Step, { effect: unknown }>): Promise<WorkRecord> {
    const subject = this.resolveRef(record, s.effect.subject)
    const decided = this.decisionOf(record, s.id)
    const verdicts = s.effect.requires.map((stepId) => [stepId, this.verdictOf(record, spec, stepId)] as const)
    const notPass = verdicts.filter(([, verdict]) => verdict !== 'pass')
    if (notPass.some(([, verdict]) => verdict !== 'inconclusive')) {
      return this.finish(record, 'failed', `${s.id} needs a passing verdict on its subject: ${notPass.map(([id, v]) => `${id}=${v ?? 'missing'}`).join(', ')}`)
    }
    if (notPass.length && !decided) {
      return this.finish(record, 'held', `${s.id} needs a passing ${notPass.map(([id]) => id).join(', ')} verdict on its subject; ${notPass.map(([id, v]) => `${id} is ${v}`).join(', ')}`, s.id)
    }
    const provider = this.capabilities.routeEffect(s.effect.capability).selected
    if (!provider) return this.finish(record, 'failed', `no enabled provider offers ${s.effect.capability} for step ${s.id}`)
    const kind = this.specs.kindOf(subject)
    if (!kind || !provider.accepts.includes(kind)) return this.finish(record, 'failed', `${provider.ref} publishes ${provider.accepts.join(', ')}, not ${kind ?? 'a missing Artifact'}`)
    const intent: EffectIntent = {
      operationId: `op:${createHash('sha256').update(`${record.id}\n${s.id}\n${subject}`).digest('hex')}`,
      workId: record.id, stepId: s.id, capability: s.effect.capability, subject, params: { ...s.effect.params },
    }
    const why = provider.approval(intent)
    if (why && !decided) return this.finish(record, 'held', `${s.id} awaits operator approval: ${why}`, s.id)
    record = await this.append(record, {
      type: 'effect-intended', stepId: s.id, operationId: intent.operationId, capability: intent.capability, subject,
      params: intent.params, provider: { ref: provider.ref, version: provider.version },
    })
    return this.applyEffect(record, provider, intent)
  }

  /**
   * Record a human operator's decision on held Work; an approval runs it on.
   * Agent callers are refused (ADR-0004 decision 3).
   */
  async decide(workId: string, decision: { decision: 'approved' | 'denied'; caller: Caller; reason: string }): Promise<WorkRecord> {
    if (decision.caller.type !== 'human') throw new WorkError('only a human operator approves; an agent caller cannot decide')
    const record = this.require(workId)
    const stepId = record.state.status === 'held' ? record.state.awaiting : undefined
    if (!stepId) throw new WorkError(`nothing awaits a decision on ${workId} (it is ${record.state.status})`)
    const release = this.control.acquire(workId)
    let decided: WorkRecord
    try {
      decided = await this.append(record, { type: 'decided', caller: decision.caller, stepId, decision: decision.decision, reason: decision.reason })
      if (decision.decision === 'denied') return await this.finish(decided, 'failed', `${stepId} denied by ${decision.caller.operatorId}: ${decision.reason}`)
    } finally {
      release()
    }
    return this.run(workId)
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
