/**
 * The Workflow file: parse, preflight and resolve (ADR-0002). A pure library;
 * Workflow definitions are data files, never plugins.
 *
 * Vocabulary (`system.workflow/v1`): `steps`, each with exactly one of a Worker
 * step (`capabilities`, `outputs`, optional `inputs`), `verify` or `accept`,
 * and optional `dependsOn`. Everything else is refused before any Worker runs.
 * The cycle check and the "a step uses only what it depends on" rule follow
 * System 1's workflow preflight (tsuuanmi/system f199a27,
 * packages/plugins/workflow/src/spec.ts).
 */
import { parse } from 'yaml'
import { z } from 'zod'

const WORKFLOW_SCHEMA = 'system.workflow/v1'
const ID = /^[a-z][a-z0-9-]{0,62}$/
const CAPABILITY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/
/** `$work.input`, or `$steps.<step>.<slot>`. */
const REF = /^\$(work\.input|steps\.([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*))$/

const id = z.string().regex(ID)
const capability = z.string().regex(CAPABILITY)
const ref = z.string().regex(REF, 'a reference is $work.input or $steps.<step>.<slot>')

const workerStep = z.object({
  id,
  dependsOn: z.array(id).optional(),
  capabilities: z.array(capability).min(1),
  inputs: z.record(id, ref).optional(),
  outputs: z.array(id).min(1),
  /** What this step's Worker is told besides the task, such as an output format. */
  instructions: z.string().min(1).max(8 * 1024).optional(),
}).strict()

const verifyStep = z.object({
  id,
  dependsOn: z.array(id).optional(),
  verify: z.object({ capability, subject: ref, criteria: z.string().min(1) }).strict(),
}).strict()

const acceptStep = z.object({
  id,
  dependsOn: z.array(id).optional(),
  accept: z.object({ requires: z.array(id).min(1), approval: z.literal('operator').optional() }).strict(),
}).strict()

const effectStep = z.object({
  id,
  dependsOn: z.array(id).optional(),
  effect: z.object({
    capability,
    subject: ref,
    /** Verify steps whose verdict on this exact subject must be `pass` before the effect runs. */
    requires: z.array(id).min(1),
    /** Provider parameters, validated by the provider at admission. */
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }).strict(),
}).strict()

const step = z.union([workerStep, verifyStep, effectStep, acceptStep])

export const workflowSchema = z.object({
  schema: z.literal(WORKFLOW_SCHEMA),
  id,
  version: z.number().int().positive(),
  steps: z.array(step).min(1).max(32),
}).strict()

export type Workflow = z.infer<typeof workflowSchema>
export type Step = Workflow['steps'][number]
export type WorkerStep = z.infer<typeof workerStep>
export type VerifyStep = z.infer<typeof verifyStep>
export type AcceptStep = z.infer<typeof acceptStep>
export type EffectStep = z.infer<typeof effectStep>

export const isWorkerStep = (s: Step): s is WorkerStep => 'capabilities' in s
export const isVerifyStep = (s: Step): s is VerifyStep => 'verify' in s
export const isAcceptStep = (s: Step): s is AcceptStep => 'accept' in s
export const isEffectStep = (s: Step): s is EffectStep => 'effect' in s

/** What the effective composition can run, checked at admission. */
export interface AvailableCapabilities {
  workers: ReadonlySet<string>
  verifiers: ReadonlySet<string>
  effects: ReadonlySet<string>
}

export class WorkflowError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`invalid workflow: ${problems.join('; ')}`)
    this.name = 'WorkflowError'
    this.problems = problems
  }
}

/** Parse YAML text; duplicate keys and non-YAML are refused. */
export function parseWorkflow(text: string): Workflow {
  let data: unknown
  try {
    data = parse(text, { uniqueKeys: true, strict: true })
  } catch (error) {
    throw new WorkflowError([`not valid YAML: ${(error as Error).message}`])
  }
  const parsed = workflowSchema.safeParse(data)
  if (!parsed.success) {
    throw new WorkflowError(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`))
  }
  return parsed.data
}

/** Every transitive dependency of each step. */
function ancestors(steps: readonly Step[]): Map<string, Set<string>> {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const memo = new Map<string, Set<string>>()
  const of = (stepId: string): Set<string> => {
    const known = memo.get(stepId)
    if (known) return known
    const all = new Set<string>()
    memo.set(stepId, all)
    for (const dep of byId.get(stepId)?.dependsOn ?? []) {
      all.add(dep)
      for (const a of of(dep)) all.add(a)
    }
    return all
  }
  for (const s of steps) of(s.id)
  return memo
}

/**
 * Check the structure and capabilities; returns the steps in a dependency
 * order (stable: file order among ready steps). Throws `WorkflowError` with
 * every problem found.
 */
export function preflight(workflow: Workflow, available: AvailableCapabilities): string[] {
  const problems: string[] = []
  const byId = new Map<string, Step>()
  for (const s of workflow.steps) {
    if (byId.has(s.id)) problems.push(`duplicate step ${s.id}`)
    byId.set(s.id, s)
  }
  for (const s of workflow.steps) {
    for (const dep of s.dependsOn ?? []) {
      if (dep === s.id) problems.push(`step ${s.id} depends on itself`)
      else if (!byId.has(dep)) problems.push(`step ${s.id} depends on unknown step ${dep}`)
    }
  }
  if (problems.length) throw new WorkflowError(problems)

  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (stepId: string, path: string[]): void => {
    if (state.get(stepId) === 'done') return
    if (state.get(stepId) === 'visiting') throw new WorkflowError([`cycle: ${[...path, stepId].join(' -> ')}`])
    state.set(stepId, 'visiting')
    for (const dep of byId.get(stepId)!.dependsOn ?? []) visit(dep, [...path, stepId])
    state.set(stepId, 'done')
  }
  for (const s of workflow.steps) visit(s.id, [])
  // Stable order: repeatedly the first step in file order whose dependencies are placed,
  // so how `dependsOn` is written never changes the resolved spec or its hash.
  const order: string[] = []
  const placed = new Set<string>()
  while (order.length < workflow.steps.length) {
    const ready = workflow.steps.find((s) => !placed.has(s.id) && (s.dependsOn ?? []).every((dep) => placed.has(dep)))!
    placed.add(ready.id)
    order.push(ready.id)
  }

  const before = ancestors(workflow.steps)
  const checkRef = (s: Step, value: string, where: string): void => {
    const match = REF.exec(value)!
    if (match[1] === 'work.input') return
    const [from, slot] = [match[2]!, match[3]!]
    const producer = byId.get(from)
    if (!producer) problems.push(`step ${s.id} ${where} ${value}: no step ${from}`)
    else if (!before.get(s.id)!.has(from)) problems.push(`step ${s.id} ${where} ${value}, but does not depend on ${from}`)
    else if (!isWorkerStep(producer) || !producer.outputs.includes(slot)) problems.push(`step ${s.id} ${where} ${value}: step ${from} has no output ${slot}`)
  }
  for (const s of workflow.steps) {
    if (isWorkerStep(s)) {
      if (new Set(s.outputs).size !== s.outputs.length) problems.push(`step ${s.id} names an output twice`)
      for (const [name, value] of Object.entries(s.inputs ?? {})) checkRef(s, value, `input ${name} uses`)
      for (const c of s.capabilities) if (!available.workers.has(c)) problems.push(`step ${s.id} needs Worker capability ${c}, which no enabled Worker provides`)
    } else if (isVerifyStep(s)) {
      checkRef(s, s.verify.subject, 'verifies')
      if (!available.verifiers.has(s.verify.capability)) problems.push(`step ${s.id} needs verifier ${s.verify.capability}, which no enabled verifier provides`)
    } else if (isEffectStep(s)) {
      checkRef(s, s.effect.subject, 'publishes')
      if (!available.effects.has(s.effect.capability)) problems.push(`step ${s.id} needs effect ${s.effect.capability}, which no enabled effect provider offers`)
      for (const required of s.effect.requires) {
        const target = byId.get(required)
        if (!target || !isVerifyStep(target)) problems.push(`step ${s.id} requires ${required}, which is not a verify step`)
        else if (!before.get(s.id)!.has(required)) problems.push(`step ${s.id} requires ${required}, but does not depend on it`)
        else if (target.verify.subject !== s.effect.subject) problems.push(`step ${s.id} publishes ${s.effect.subject}, but ${required} verified ${target.verify.subject}`)
      }
    } else {
      for (const required of s.accept.requires) {
        const target = byId.get(required)
        if (!target || !isVerifyStep(target)) problems.push(`step ${s.id} accepts on ${required}, which is not a verify step`)
        else if (!before.get(s.id)!.has(required)) problems.push(`step ${s.id} accepts on ${required}, but does not depend on it`)
      }
    }
  }
  const accepts = workflow.steps.filter(isAcceptStep)
  if (accepts.length > 1) problems.push(`a workflow has at most one accept step; found ${accepts.map((s) => s.id).join(', ')}`)
  const used = new Set(workflow.steps.flatMap((s) => s.dependsOn ?? []))
  if (accepts.length === 1 && used.has(accepts[0]!.id)) problems.push(`accept step ${accepts[0]!.id} must be last: other steps depend on it`)
  if (problems.length) throw new WorkflowError(problems)
  return order
}

/**
 * The resolved spec pinned at admission: the validated workflow with each
 * step's `dependsOn` sorted and its steps in dependency order. Its Artifact ID
 * is the spec hash.
 */
export interface ResolvedSpec {
  workflow: { id: string; version: number }
  steps: Step[]
}

export function resolve(workflow: Workflow, available: AvailableCapabilities): ResolvedSpec {
  const order = preflight(workflow, available)
  const byId = new Map(workflow.steps.map((s) => [s.id, s]))
  return {
    workflow: { id: workflow.id, version: workflow.version },
    steps: order.map((stepId) => {
      const s = byId.get(stepId)!
      return s.dependsOn ? { ...s, dependsOn: [...new Set(s.dependsOn)].sort() } : s
    }),
  }
}

/** A single Task with no Workflow file: one implicit Worker step (ADR-0002 decision 1). */
export function directTask(capabilities: string[], hasInput: boolean, available: AvailableCapabilities): ResolvedSpec {
  return resolve({
    schema: WORKFLOW_SCHEMA,
    id: 'task',
    version: 1,
    steps: [{ id: 'task', capabilities, ...(hasInput ? { inputs: { input: '$work.input' } } : {}), outputs: ['result'] }],
  }, available)
}
