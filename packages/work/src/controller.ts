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
import type { Capabilities } from './registry.ts'
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
  private readonly now: () => string

  constructor(table: WorkTable, specs: SpecStore, capabilities: Capabilities, now: () => string = () => new Date().toISOString()) {
    this.table = table
    this.specs = specs
    this.capabilities = capabilities
    this.now = now
  }

  /** Pin the spec and create the Work record; nothing is dispatched yet. */
  async admit(admission: Admission): Promise<WorkRecord> {
    const usesInput = admission.spec.steps.some((s) => refsOf(s).includes('$work.input'))
    if (usesInput && !admission.input) throw new WorkError('the workflow uses $work.input, but no input Artifact was given')
    if (admission.input && !this.specs.exists(admission.input)) throw new WorkError(`input ${admission.input} is not a stored Artifact`)
    const specId = await this.specs.putSpec(admission.spec, admission.caller)
    const id = `work:${randomUUID()}`
    const admitted: WorkEvent = { type: 'admitted', seq: 0, at: this.now(), caller: admission.caller, specId, input: admission.input, source: admission.source }
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

  /** Advance until the Work is terminal. */
  async run(workId: string): Promise<WorkRecord> {
    let record = await this.recover(this.require(workId))
    while (!TERMINAL.has(record.state.status)) record = await this.step(record)
    return record
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
    const failed = spec.steps.find((s) => record.state.steps[s.id]!.state === 'failed')
    if (failed) return this.finish(record, 'failed', `step ${failed.id} failed`)
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
    const route = this.capabilities.routeWorker(s.capabilities)
    if (!route.selected) return this.finish(record, 'failed', `no enabled Worker provides ${s.capabilities.join(', ')} for step ${s.id}`)
    const attemptId = `attempt:${randomUUID()}`
    record = await this.append(record, {
      type: 'dispatched', stepId: s.id, attemptId, executor: 'worker', capability: s.capabilities.join(','),
      selected: route.selected.ref, candidates: route.candidates, inputs,
    })
    let result
    try {
      result = await route.selected.run({ workId: record.id, attemptId, stepId: s.id, capabilities: s.capabilities, inputs, outputs: s.outputs })
    } catch (error) {
      result = { status: 'failed' as const, outputs: {}, reason: `the Worker threw: ${(error as Error).message}` }
    }
    let { status, reason } = result
    const outputs = status === 'succeeded' ? result.outputs : {}
    if (status === 'succeeded') {
      // A Worker's word is not its output: every declared slot must name a stored Artifact.
      const missing = s.outputs.filter((slot) => !outputs[slot] || !this.specs.exists(outputs[slot]))
      if (missing.length) [status, reason] = ['failed', `the Worker reported success without stored outputs ${missing.join(', ')}`]
    }
    return this.append(record, {
      type: 'observed', stepId: s.id, attemptId, status, outputs: status === 'succeeded' ? pick(outputs, s.outputs) : {}, reason,
      usage: result.usage ? { state: 'observed', ...result.usage } : { state: 'unknown' },
    })
  }

  private async runVerifier(record: WorkRecord, s: Extract<Step, { verify: unknown }>): Promise<WorkRecord> {
    const subject = this.resolveRef(record, s.verify.subject)
    const route = this.capabilities.routeVerifier(s.verify.capability)
    if (!route.selected) return this.finish(record, 'failed', `no enabled verifier provides ${s.verify.capability} for step ${s.id}`)
    const attemptId = `attempt:${randomUUID()}`
    record = await this.append(record, {
      type: 'dispatched', stepId: s.id, attemptId, executor: 'verifier', capability: s.verify.capability,
      selected: route.selected.ref, candidates: route.candidates, inputs: { subject },
    })
    let result
    try {
      result = await route.selected.verify({ workId: record.id, attemptId, stepId: s.id, capability: s.verify.capability, subject, criteria: s.verify.criteria })
    } catch (error) {
      result = { verdict: 'error' as const, reason: `the verifier threw: ${(error as Error).message}` }
    }
    return this.append(record, {
      type: 'verified', stepId: s.id, attemptId, subject, criteria: s.verify.criteria,
      verdict: result.verdict, reason: result.reason, verdictId: result.verdictId,
    })
  }

  /** With no accept step, every verify step still decides: missing evidence is never a pass. */
  private finishWithoutAccept(record: WorkRecord, spec: ResolvedSpec): Promise<WorkRecord> {
    const verdicts = spec.steps.filter(isVerifyStep).map((s) => [s.id, record.state.steps[s.id]!.verdict] as const)
    const bad = verdicts.filter(([, verdict]) => verdict !== 'pass' && verdict !== 'inconclusive')
    if (bad.length) return this.finish(record, 'failed', `verification did not pass: ${bad.map(([id, v]) => `${id}=${v ?? 'missing'}`).join(', ')}`)
    const unsure = verdicts.filter(([, verdict]) => verdict === 'inconclusive')
    if (unsure.length) return this.finish(record, 'held', `inconclusive verification needs an operator decision: ${unsure.map(([id]) => id).join(', ')}`)
    return this.finish(record, 'succeeded', 'every step succeeded')
  }

  private accept(record: WorkRecord, s: Extract<Step, { accept: unknown }>): Promise<WorkRecord> {
    const verdicts = s.accept.requires.map((stepId) => [stepId, record.state.steps[stepId]!.verdict] as const)
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

function refsOf(s: Step): string[] {
  if (isWorkerStep(s)) return Object.values(s.inputs ?? {})
  if (isVerifyStep(s)) return [s.verify.subject]
  return []
}

function pick(outputs: Record<string, string>, slots: readonly string[]): Record<string, string> {
  return Object.fromEntries(slots.map((slot) => [slot, outputs[slot]!]))
}
