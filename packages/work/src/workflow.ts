/**
 * The Workflow file: parse, preflight and resolve (ADR-0002 and its
 * Sub-workflow amendment). A pure library; Workflow definitions are data
 * files, never plugins. The cycle check and the "a step uses only what it
 * depends on" rule follow System 1's workflow preflight (tsuuanmi/system
 * f199a27, packages/plugins/workflow/src/spec.ts).
 */
import { parse } from 'yaml'
import { z } from 'zod'

const WORKFLOW_SCHEMA = 'system.workflow/v1'
const ID = /^[a-z][a-z0-9-]{0,62}$/
/** A step ID: a name, or after Sub-workflows are joined, names under the using steps' (`checks.checks`). */
const STEP_ID = /^[a-z][a-z0-9-]{0,62}(\.[a-z][a-z0-9-]{0,62}){0,3}$/
const CAPABILITY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/
/** `$work.input`, or `$steps.<step>.<slot>`; the step is all but the last name. */
const REF = /^\$(work\.input|steps\.((?:[a-z][a-z0-9-]*\.){0,3}[a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*))$/
/** The Workflow file a step uses: a file beside the using one. */
const FILE = /^[a-z0-9][a-z0-9-]*\.ya?ml$/
/** How many levels of Sub-workflows a Workflow may use. */
const MAX_DEPTH = 3
const MAX_STEPS = 32

const id = z.string().regex(STEP_ID)
const slot = z.string().regex(ID)
const capability = z.string().regex(CAPABILITY)
const ref = z.string().regex(REF, 'a reference is $work.input or $steps.<step>.<slot>')

/**
 * One automatic further attempt after a failure that can be fixed (Item df-7):
 * `rerunUnchanged`: when a failing check reopened the step and it changes nothing, the check runs again on the same change once (sc-9).
 * `onFail` names the verify steps that judge, or come after, this step and whose
 * `fail` verdict reopens it, and this step itself for a failure its Worker says may be tried afresh, and a later Worker step whose final message objects (`OBJECTION:`) to this step's output,
 * and a later effect step whose outcome was observed as a conflict with the base or a failed merge check (sc-7): this step is reopened on the base's new tip. An unknown outcome is never retried.
 */
const retry = z.object({ onFail: z.array(id).min(1), max: z.number().int().min(1).max(3), rerunUnchanged: z.literal(true).optional() }).strict()

const workerStep = z.object({
  id,
  dependsOn: z.array(id).optional(),
  capabilities: z.array(capability).min(1),
  inputs: z.record(slot, ref).optional(),
  outputs: z.array(slot).min(1),
  /** What this step's Worker is told besides the task, such as an output format. */
  instructions: z.string().min(1).max(8 * 1024).optional(),
  retry: retry.optional(),
  /** A `git-tree` Artifact (such as `$steps.tests.change`) whose changed files are put back, as it left them, into this step's first output before it is recorded; a Worker cannot change them (dg-10). */
  freeze: ref.optional(),
  /** The step's change may equal its base (a docs step with nothing stale): passed on instead of failing with "no change". */
  mayBeEmpty: z.boolean().optional(),
}).strict()

const verifyStep = z.object({
  id,
  dependsOn: z.array(id).optional(),
  /** `inputs` are further Artifacts the verifier is given beside the subject, such as the report a sources file belongs to. */
  verify: z.object({ capability, subject: ref, criteria: z.string().min(1), inputs: z.record(slot, ref).optional(),
    /** An `inconclusive` verdict holds the Work at this step for the operator (`awaiting` it) before any step after it starts (dg-2). */
    holdInconclusive: z.literal(true).optional() }).strict(),
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

const usesStep = z.object({
  id,
  dependsOn: z.array(id).optional(),
  uses: z.string().regex(FILE, 'uses names a Workflow file beside this one, such as code-checks.yaml'),
  /** What the Sub-workflow reads as `$work.input`; without it, this Workflow's own input. */
  inputs: z.object({ input: ref }).strict().optional(),
  /** Slot -> a `$steps.<step>.<slot>` of the Sub-workflow, read by this Workflow as `$steps.<this step>.<slot>`. */
  outputs: z.record(slot, ref).optional(),
}).strict()

/** A step of a resolved spec: every Sub-workflow joined. */
export const stepSchema = z.union([workerStep, verifyStep, effectStep, acceptStep])

export const workflowSchema = z.object({
  schema: z.literal(WORKFLOW_SCHEMA),
  id: z.string().regex(ID),
  version: z.number().int().positive(),
  steps: z.array(z.union([workerStep, verifyStep, effectStep, acceptStep, usesStep])).min(1).max(MAX_STEPS),
}).strict()

export type Workflow = z.infer<typeof workflowSchema>
export type Step = z.infer<typeof stepSchema>
export type UsesStep = z.infer<typeof usesStep>
export type WorkerStep = z.infer<typeof workerStep>
export type VerifyStep = z.infer<typeof verifyStep>
export type AcceptStep = z.infer<typeof acceptStep>
export type EffectStep = z.infer<typeof effectStep>

type AnyStep = Step | UsesStep
export const isWorkerStep = (s: AnyStep): s is WorkerStep => 'capabilities' in s
export const isVerifyStep = (s: AnyStep): s is VerifyStep => 'verify' in s
export const isAcceptStep = (s: AnyStep): s is AcceptStep => 'accept' in s
export const isEffectStep = (s: AnyStep): s is EffectStep => 'effect' in s
const isUsesStep = (s: AnyStep): s is UsesStep => 'uses' in s

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
export function preflight(workflow: { steps: Step[] }, available: AvailableCapabilities): string[] {
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
      if (s.freeze) checkRef(s, s.freeze, 'freezes')
      for (const c of s.capabilities) if (!available.workers.has(c)) problems.push(`step ${s.id} needs Worker capability ${c}, which no enabled Worker provides`)
      for (const failing of s.retry?.onFail ?? []) {
        const target = byId.get(failing)
        if (!target) problems.push(`step ${s.id} retry.onFail names ${failing}, which is not a step`)
        else if (failing !== s.id && !((isWorkerStep(target) || isEffectStep(target)) && before.get(failing)!.has(s.id)) && !(isVerifyStep(target) && (s.outputs.some((slot) => target.verify.subject === `$steps.${s.id}.${slot}`) || before.get(failing)!.has(s.id)))) problems.push(`step ${s.id} retry.onFail names ${failing}, which neither judges nor follows ${s.id}`)
      }
    } else if (isVerifyStep(s)) {
      checkRef(s, s.verify.subject, 'verifies')
      for (const [name, value] of Object.entries(s.verify.inputs ?? {})) checkRef(s, value, `input ${name} uses`)
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

/** A used Workflow file's text by its name; throws `WorkflowError` when there is none. */
export type WorkflowFiles = (name: string) => string

/** Rename what a joined step refers to: step IDs by `id`, `$steps` references by `ref`. */
function rename(s: Step, id: (stepId: string) => string, ref: (value: string) => string): Step {
  const ids = { id: id(s.id), ...(s.dependsOn ? { dependsOn: s.dependsOn.map(id) } : {}) }
  if (isWorkerStep(s)) return { ...s, ...ids, ...(s.retry ? { retry: { ...s.retry, onFail: s.retry.onFail.map(id) } } : {}), ...(s.inputs ? { inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, ref(v)])) } : {}), ...(s.freeze ? { freeze: ref(s.freeze) } : {}) }
  if (isVerifyStep(s)) return { ...s, ...ids, verify: { ...s.verify, subject: ref(s.verify.subject), ...(s.verify.inputs ? { inputs: Object.fromEntries(Object.entries(s.verify.inputs).map(([k, v]) => [k, ref(v)])) } : {}) } }
  if (isEffectStep(s)) return { ...s, ...ids, effect: { ...s.effect, subject: ref(s.effect.subject), requires: s.effect.requires.map(id) } }
  return { ...s, ...ids, accept: { ...s.accept, requires: s.accept.requires.map(id) } }
}

/** Join every Sub-workflow of `workflow` into its steps; `chain` is the IDs of the Workflows using it, outermost first. */
function join(workflow: Workflow, files: WorkflowFiles | undefined, chain: string[]): Step[] {
  const problems: string[] = []
  const joined: Step[] = []
  /** For each using step: the IDs of its steps, and its outputs as references to them. */
  const used = new Map<string, { ids: string[]; outputs: Record<string, string> }>()
  for (const s of workflow.steps) {
    if (s.id.includes('.')) problems.push(`step ${s.id}: a step ID has no "." (IDs under a step come from its uses)`)
    if (!isUsesStep(s)) { joined.push(s); continue }
    if (chain.length > MAX_DEPTH) { problems.push(`step ${s.id} uses ${s.uses}: Sub-workflows go no deeper than ${MAX_DEPTH} levels`); continue }
    if (!files) { problems.push(`step ${s.id} uses ${s.uses}, but no Workflow files were given`); continue }
    let inner: Workflow
    try {
      inner = parseWorkflow(files(s.uses))
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error
      problems.push(...error.problems.map((problem) => `step ${s.id} uses ${s.uses}: ${problem}`))
      continue
    }
    if (chain.includes(inner.id)) { problems.push(`recursion: ${[...chain, inner.id].join(' -> ')}`); continue }
    const steps = join(inner, files, [...chain, inner.id])
    const accept = steps.find(isAcceptStep)
    if (accept) { problems.push(`step ${s.id} uses ${s.uses}, which has an accept step (${accept.id}); the using Workflow accepts`); continue }
    const ids = new Set(steps.map((t) => t.id))
    const under = (stepId: string) => (ids.has(stepId) ? `${s.id}.${stepId}` : stepId)
    const ref = (value: string): string => {
      if (value === '$work.input') return s.inputs?.input ?? value
      const match = REF.exec(value)!
      return ids.has(match[2]!) ? `$steps.${s.id}.${match[2]}.${match[3]}` : value
    }
    const names = steps.map((t) => `${s.id}.${t.id}`)
    for (const t of steps) {
      const renamed = rename(t, under, ref)
      // A step with no dependency inside starts after what the using step depends on.
      joined.push(t.dependsOn?.length ? renamed : { ...renamed, ...(s.dependsOn ? { dependsOn: [...s.dependsOn] } : {}) } as Step)
    }
    used.set(s.id, { ids: names, outputs: Object.fromEntries(Object.entries(s.outputs ?? {}).map(([name, value]) => [name, ref(value)])) })
  }
  if (problems.length) throw new WorkflowError(problems)
  // What this Workflow says of a using step means its steps, or the output it names.
  const ref = (value: string): string => {
    const match = REF.exec(value)
    const outputs = match?.[2] ? used.get(match[2])?.outputs : undefined
    return outputs?.[match![3]!] ?? value
  }
  const deps = (stepId: string): string[] => used.get(stepId)?.ids ?? [stepId]
  return joined.map((t) => {
    const renamed = rename(t, (stepId) => stepId, ref)
    return renamed.dependsOn ? { ...renamed, dependsOn: renamed.dependsOn.flatMap(deps) } as Step : renamed
  })
}

export function resolve(workflow: Workflow, available: AvailableCapabilities, files?: WorkflowFiles): ResolvedSpec {
  const steps = join(workflow, files, [workflow.id])
  if (steps.length > MAX_STEPS) throw new WorkflowError([`with its Sub-workflows the workflow has ${steps.length} steps; at most ${MAX_STEPS}`])
  const order = preflight({ steps }, available)
  const byId = new Map(steps.map((s) => [s.id, s]))
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
