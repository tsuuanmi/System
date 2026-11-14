/**
 * The Work record (ADR-0004 decision 9): one storage key per Work holding its
 * append-only events and the state they fold to. `fold(events)` is pure, so
 * replay of the recorded events always yields the stored state; replay never
 * re-runs a Worker, a verifier or an external effect.
 */
import { contentIdSchema } from '@system/artifacts'
import { z } from 'zod'

const at = z.string()
const TERMINAL_STATUSES = ['succeeded', 'failed', 'held', 'cancelled'] as const
const status = z.enum(['running', ...TERMINAL_STATUSES])
const operatorId = z.string().min(1)
/** Who issues a command: the only callers a new event carries. */
export const callerSchema = z.object({ type: z.enum(['human', 'agent']), operatorId }).strict()
/**
 * A caller as a stored event may name it. `orchestrator` is no longer issued (ADR-0009 is superseded); it stays
 * accepted so records stored before still open and replay.
 */
const storedCallerSchema = z.discriminatedUnion('type', [
  callerSchema,
  z.object({ type: z.literal('orchestrator'), operatorId, goal: contentIdSchema }).strict(),
])

/** Why a candidate Worker or verifier was or was not chosen. */
const candidate = z.object({ ref: z.string(), selected: z.boolean(), reason: z.string() }).strict()

/** Which account, binary and version ran an attempt (ADR-0005 decision 5). */
export const executorSchema = z.object({
  ref: z.string(), account: z.string().optional(), command: z.string().optional(), version: z.string().optional(),
  /** The tier the step asked for, the model configured for it, and the models the CLI reports it served. */
  tier: z.string().optional(), model: z.string().optional(), servedModels: z.array(z.string()).optional(),
}).strict()

export const usageSchema = z.union([
  z.object({ state: z.literal('unknown') }).strict(),
  z.object({ state: z.literal('observed'), inputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative().optional(), cacheWriteTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative().optional(), source: z.string() }).strict(),
])

export type ExecutorRecord = z.infer<typeof executorSchema>
export type UsageObserved = Extract<z.infer<typeof usageSchema>, { state: 'observed' }>

export const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('admitted'), seq: z.number().int(), at, caller: storedCallerSchema,
    specId: contentIdSchema, input: contentIdSchema.optional(),
    /** Read-only: the Goal a Work was admitted for, in records stored before Goals were removed. New events never carry it. */
    goal: contentIdSchema.optional(),
    /** The Item of a repository's STATUS.md the input Task names (Item df-3); absent when it names none. */
    item: z.object({ id: z.string(), repository: z.string().optional() }).strict().optional(),
    /** Only this Worker may take the Work's Worker steps (`system work submit --worker`), unless a retry names another. */
    worker: z.string().optional(),
    /** Each verify step's criteria Artifact, pinned at admission. */
    criteria: z.record(z.string(), contentIdSchema).optional(),
    /** Each verify step's verifier and version, pinned at admission (absent in records written before M6). */
    verifiers: z.record(z.string(), z.object({ ref: z.string(), version: z.string() }).strict()).optional(),
    source: z.object({ kind: z.enum(['workflow-file', 'direct-task']), path: z.string().optional(), fileHash: z.string().optional() }).strict(),
  }).strict(),
  z.object({
    type: z.literal('dispatched'), seq: z.number().int(), at,
    stepId: z.string(), attemptId: z.string(), executor: z.enum(['worker', 'verifier']),
    capability: z.string(), selected: z.string(), candidates: z.array(candidate),
    inputs: z.record(z.string(), contentIdSchema),
    /** How long the step waited for a free slot before this dispatch (the Account's or the check's); absent when it did not wait. */
    waitedMs: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    type: z.literal('observed'), seq: z.number().int(), at,
    stepId: z.string(), attemptId: z.string(), status: z.enum(['succeeded', 'failed', 'cancelled']),
    outputs: z.record(z.string(), contentIdSchema), reason: z.string().optional(), usage: usageSchema,
    /** What a cancelled attempt left behind: kept, never accepted as the step's output. */
    partial: z.record(z.string(), contentIdSchema).optional(),
    /** The bounded agent output, for audit only; never handed to another Worker. */
    log: contentIdSchema.optional(),
    worker: executorSchema.optional(),
    /** Old records only: the attempt failed on a rate limit of its Account (the step stayed failed). */
    rateLimited: z.literal(true).optional(),
    /** The attempt failed because its Account is out of quota or credits: not a step failure; the step is dispatched again by routing. */
    limited: z.literal(true).optional(),
    /** The Worker says this failure may be tried afresh (`retry.onFail` names the step itself). */
    retryable: z.literal(true).optional(),
    /** Old records only: never written (a later step's final message objected to an earlier step's output). */
    objection: z.string().optional(),
    /** A no-change attempt on a step reopened by this failing verdict, passed on as the same change (`retry.rerunUnchanged`): the check runs again on it. */
    unchangedAfter: contentIdSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('verified'), seq: z.number().int(), at,
    stepId: z.string(), attemptId: z.string(), subject: contentIdSchema, criteria: z.string(),
    verdict: z.enum(['pass', 'fail', 'inconclusive', 'error']), reason: z.string(),
    verdictId: contentIdSchema.optional(),
    evidence: z.array(contentIdSchema).optional(),
    verifier: z.object({ ref: z.string(), version: z.string() }).strict().optional(),
    /** The second run of the check on the same change; the id is the first run's verdict. */
    rerunOf: contentIdSchema.optional(),
  }).strict(),
  z.object({
    /** A step whose `when`/`unless` condition on an optional output was not met: it does not run, and counts as done for the steps after it. */
    type: z.literal('skipped'), seq: z.number().int(), at,
    stepId: z.string(), reason: z.string(),
  }).strict(),
  z.object({
    type: z.literal('attempt-lost'), seq: z.number().int(), at,
    stepId: z.string(), attemptId: z.string(), reason: z.string(),
  }).strict(),
  z.object({
    type: z.literal('reopened'), seq: z.number().int(), at,
    /** Absent when `automatic`: the Workflow's `retry` reopened the step, no caller did. */
    caller: storedCallerSchema.optional(),
    automatic: z.literal(true).optional(),
    stepId: z.string(), reason: z.string(),
    /** An automatic retry after a failing verdict: that verdict Artifact, handed to the new attempt as input `failure`. */
    failure: contentIdSchema.optional(),
    /** Old records only: never written (an automatic reopening after this later step's objection). */
    objectedBy: z.string().optional(),
    /** An automatic reopening after this later effect step's observed conflict or failed merge check (`rejected`); `failure` is its reason as a verdict. */
    failedEffect: z.string().optional(),
    /** The git-tree Artifact of the base branch's current tip, handed to the new attempt as input `base`. */
    base: contentIdSchema.optional(),
    /** Only this Worker may take the step over. */
    worker: z.string().optional(),
    /** The previous attempt's partial output, handed to the new attempt as input `previous`. */
    previous: contentIdSchema.optional(),
    /** Steps reset with it: the step and everything that depends on it, so no verdict outlives its subject. */
    reset: z.array(z.string()).optional(),
  }).strict(),
  z.object({
    type: z.literal('effect-intended'), seq: z.number().int(), at,
    stepId: z.string(), operationId: z.string(), capability: z.string(), subject: contentIdSchema,
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    provider: z.object({ ref: z.string(), version: z.string() }).strict(),
  }).strict(),
  z.object({
    type: z.literal('effect-observed'), seq: z.number().int(), at,
    stepId: z.string(), operationId: z.string(),
    /** `absent` and `unknown` come from reconciliation, which only reads the remote. */
    state: z.enum(['applied', 'failed', 'absent', 'unknown']), reason: z.string(),
    detail: z.record(z.string(), z.string()).optional(),
    /** The remote observed a conflict with the base or a failing check on the merge (`EffectOutcome.rejected`); only such an outcome may reopen a step. */
    rejected: z.enum(['conflict', 'merge-check']).optional(),
  }).strict(),
  z.object({
    type: z.literal('decided'), seq: z.number().int(), at, caller: storedCallerSchema,
    stepId: z.string(), decision: z.enum(['approved', 'denied']), reason: z.string(),
  }).strict(),
  z.object({
    type: z.literal('terminal'), seq: z.number().int(), at,
    outcome: z.enum(TERMINAL_STATUSES), reason: z.string(),
    results: z.record(z.string(), contentIdSchema), caller: storedCallerSchema.optional(),
    /** `satisfied`: the Item already held at the Task's base, shown by a verify step with `result` (GLOSSARY: Satisfied); nothing was published. */
    result: z.literal('satisfied').optional(),
    /** For `held`: the step whose operator decision `system approve` records. */
    awaiting: z.string().optional(),
  }).strict(),
])

export type WorkEvent = z.infer<typeof eventSchema>
export type NewEvent = WorkEvent extends infer E ? (E extends { seq: number; at: string } ? Omit<E, 'seq' | 'at'> : never) : never
export type Caller = z.infer<typeof callerSchema>

const stepState = z.object({
  state: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'skipped']),
  attempts: z.array(z.string()),
  outputs: z.record(z.string(), contentIdSchema),
  partial: z.record(z.string(), contentIdSchema).optional(),
  verdict: z.enum(['pass', 'fail', 'inconclusive', 'error']).optional(),
  /** For a verify step: the exact subject its verdict is about. */
  subject: contentIdSchema.optional(),
  /** An operator's decision on this step (approval of an effect or of an inconclusive verdict). */
  decision: z.enum(['approved', 'denied']).optional(),
}).strict()

const effectState = z.object({
  stepId: z.string(),
  state: z.enum(['intended', 'applied', 'failed', 'absent', 'unknown']),
  detail: z.record(z.string(), z.string()).optional(),
}).strict()

export const stateSchema = z.object({
  status,
  specId: contentIdSchema,
  input: contentIdSchema.optional(),
  /** Added in M4; records written before it read as `{}` (DSH validates every stored record at open). */
  criteria: z.record(z.string(), contentIdSchema).default({}),
  steps: z.record(z.string(), stepState),
  /** Added in M5; operation ID -> what is known of that external effect. */
  effects: z.record(z.string(), effectState).default({}),
  reason: z.string().optional(),
  awaiting: z.string().optional(),
  /** Added with ro-15; set by a terminal event that carries it. */
  result: z.literal('satisfied').optional(),
  results: z.record(z.string(), contentIdSchema),
}).strict()

export type WorkState = z.infer<typeof stateSchema>
export type StepState = z.infer<typeof stepState>

/**
 * What a command left in the Work it changed (PROP-0004 C8): its client ID,
 * a hash of its canonical arguments, and its result. Written in the same
 * update as the event that caused it; absent from records written before.
 */
const receipt = z.object({
  commandId: z.string().min(1),
  args: z.string(),
  result: z.object({ workId: z.string(), status }).strict(),
}).strict()

/** A session's claim on an Item before it submits a Work (df-24): who, and since when. A Work for the Item takes it over. */
export const claimSchema = z.object({ repository: z.string(), item: z.string(), who: z.string(), at }).strict()
export type Claim = z.infer<typeof claimSchema>

export const workRecordSchema = z.object({
  id: z.string(),
  events: z.array(eventSchema).min(1),
  state: stateSchema,
  receipts: z.array(receipt).optional(),
}).strict()

export type WorkRecord = z.infer<typeof workRecordSchema>
export type Receipt = z.infer<typeof receipt>

export const TERMINAL = new Set<WorkState['status']>(TERMINAL_STATUSES)

/** Fold events into state. Pure and total over valid event sequences. */
export function fold(stepIds: readonly string[], events: readonly WorkEvent[]): WorkState {
  const first = events[0]
  if (!first || first.type !== 'admitted') throw new TypeError('a Work record starts with its admission')
  const steps: Record<string, StepState> = Object.fromEntries(stepIds.map((stepId) => [stepId, { state: 'pending', attempts: [], outputs: {} }]))
  const state: WorkState = { status: 'running', specId: first.specId, input: first.input, criteria: { ...first.criteria }, steps, effects: {}, results: {} }
  for (const event of events.slice(1)) {
    switch (event.type) {
      case 'admitted':
        throw new TypeError('a Work is admitted once')
      case 'dispatched': {
        const s = steps[event.stepId]!
        s.state = 'running'
        s.attempts.push(event.attemptId)
        break
      }
      case 'observed': {
        const s = steps[event.stepId]!
        if (event.limited) { s.state = 'pending'; break }
        s.state = event.status
        if (event.status === 'succeeded') s.outputs = { ...event.outputs }
        if (event.partial) s.partial = { ...event.partial }
        break
      }
      case 'verified': {
        const s = steps[event.stepId]!
        s.verdict = event.verdict
        s.subject = event.subject
        s.state = 'succeeded'
        break
      }
      case 'skipped':
        steps[event.stepId]!.state = 'skipped'
        break
      case 'attempt-lost':
        steps[event.stepId]!.state = 'pending'
        break
      case 'reopened':
        delete state.awaiting
        for (const stepId of event.reset ?? []) {
          if (stepId === event.stepId) continue
          steps[stepId] = { state: 'pending', attempts: steps[stepId]!.attempts, outputs: {} }
        }
        steps[event.stepId]!.state = 'pending'
        steps[event.stepId]!.outputs = {}
        // A verify step asked again: its last verdict is recorded and no longer counts.
        delete steps[event.stepId]!.verdict
        delete steps[event.stepId]!.subject
        delete steps[event.stepId]!.decision
        state.status = 'running'
        delete state.reason
        delete state.result
        state.results = {}
        break
      case 'effect-intended':
        steps[event.stepId]!.state = 'running'
        state.effects[event.operationId] = { stepId: event.stepId, state: 'intended' }
        break
      case 'effect-observed': {
        const effect = state.effects[event.operationId]!
        effect.state = event.state
        if (event.detail) effect.detail = { ...event.detail }
        if (event.state === 'applied') steps[event.stepId]!.state = 'succeeded'
        if (event.state === 'failed') steps[event.stepId]!.state = 'failed'
        // A hold on an unknown outcome (no decision awaited) ends once the outcome is known.
        if (event.state !== 'unknown' && state.status === 'held' && !state.awaiting) {
          state.status = 'running'
          delete state.reason
        }
        break
      }
      case 'decided':
        steps[event.stepId]!.decision = event.decision
        state.status = 'running'
        delete state.reason
        delete state.awaiting
        break
      case 'terminal':
        state.status = event.outcome
        state.reason = event.reason
        state.results = { ...event.results }
        if (event.result) state.result = event.result
        if (event.awaiting) state.awaiting = event.awaiting
        break
    }
  }
  return state
}
