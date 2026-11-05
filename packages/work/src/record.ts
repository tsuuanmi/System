/**
 * The Work record (ADR-0004 decision 9): one storage key per Work holding its
 * append-only events and the state they fold to. `fold(events)` is pure, so
 * replay of the recorded events always yields the stored state; replay never
 * re-runs a Worker, a verifier or an external effect.
 */
import { z } from 'zod'

const at = z.string()
const artifactId = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const caller = z.object({ type: z.enum(['human', 'agent']), operatorId: z.string().min(1) }).strict()

/** Why a candidate Worker or verifier was or was not chosen. */
const candidate = z.object({ ref: z.string(), selected: z.boolean(), reason: z.string() }).strict()

/** Which account, binary and version ran an attempt (ADR-0005 decision 5). */
const executor = z.object({
  ref: z.string(), account: z.string().optional(), command: z.string().optional(), version: z.string().optional(),
  /** The tier the step asked for, the model configured for it, and the models the CLI reports it served. */
  tier: z.string().optional(), model: z.string().optional(), servedModels: z.array(z.string()).optional(),
}).strict()

const usage = z.union([
  z.object({ state: z.literal('unknown') }).strict(),
  z.object({ state: z.literal('observed'), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), source: z.string() }).strict(),
])

export const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('admitted'), seq: z.number().int(), at, caller,
    specId: artifactId, input: artifactId.optional(),
    /** Each verify step's criteria Artifact, pinned at admission. */
    criteria: z.record(z.string(), artifactId).optional(),
    source: z.object({ kind: z.enum(['workflow-file', 'direct-task']), path: z.string().optional(), fileHash: z.string().optional() }).strict(),
  }).strict(),
  z.object({
    type: z.literal('dispatched'), seq: z.number().int(), at,
    stepId: z.string(), attemptId: z.string(), executor: z.enum(['worker', 'verifier']),
    capability: z.string(), selected: z.string(), candidates: z.array(candidate),
    inputs: z.record(z.string(), artifactId),
  }).strict(),
  z.object({
    type: z.literal('observed'), seq: z.number().int(), at,
    stepId: z.string(), attemptId: z.string(), status: z.enum(['succeeded', 'failed', 'cancelled']),
    outputs: z.record(z.string(), artifactId), reason: z.string().optional(), usage,
    /** What a cancelled attempt left behind: kept, never accepted as the step's output. */
    partial: z.record(z.string(), artifactId).optional(),
    /** The bounded agent output, for audit only; never handed to another Worker. */
    log: artifactId.optional(),
    worker: executor.optional(),
  }).strict(),
  z.object({
    type: z.literal('verified'), seq: z.number().int(), at,
    stepId: z.string(), attemptId: z.string(), subject: artifactId, criteria: z.string(),
    verdict: z.enum(['pass', 'fail', 'inconclusive', 'error']), reason: z.string(),
    verdictId: artifactId.optional(),
    evidence: z.array(artifactId).optional(),
    verifier: z.object({ ref: z.string(), version: z.string() }).strict().optional(),
  }).strict(),
  z.object({
    type: z.literal('attempt-lost'), seq: z.number().int(), at,
    stepId: z.string(), attemptId: z.string(), reason: z.string(),
  }).strict(),
  z.object({
    type: z.literal('reopened'), seq: z.number().int(), at, caller,
    stepId: z.string(), reason: z.string(),
    /** Only this Worker may take the step over. */
    worker: z.string().optional(),
    /** The previous attempt's partial output, handed to the new attempt as input `previous`. */
    previous: artifactId.optional(),
    /** Steps reset with it: the step and everything that depends on it, so no verdict outlives its subject. */
    reset: z.array(z.string()).optional(),
  }).strict(),
  z.object({
    type: z.literal('terminal'), seq: z.number().int(), at,
    outcome: z.enum(['succeeded', 'failed', 'held', 'cancelled']), reason: z.string(),
    results: z.record(z.string(), artifactId), caller: caller.optional(),
  }).strict(),
])

export type WorkEvent = z.infer<typeof eventSchema>
export type NewEvent = WorkEvent extends infer E ? (E extends { seq: number; at: string } ? Omit<E, 'seq' | 'at'> : never) : never
export type Caller = z.infer<typeof caller>
export type Usage = z.infer<typeof usage>

const stepState = z.object({
  state: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  attempts: z.array(z.string()),
  outputs: z.record(z.string(), artifactId),
  partial: z.record(z.string(), artifactId).optional(),
  verdict: z.enum(['pass', 'fail', 'inconclusive', 'error']).optional(),
  /** For a verify step: the exact subject its verdict is about. */
  subject: artifactId.optional(),
}).strict()

export const stateSchema = z.object({
  status: z.enum(['running', 'succeeded', 'failed', 'held', 'cancelled']),
  specId: artifactId,
  input: artifactId.optional(),
  /** Added in M4; records written before it read as `{}` (DSH validates every stored record at open). */
  criteria: z.record(z.string(), artifactId).default({}),
  steps: z.record(z.string(), stepState),
  reason: z.string().optional(),
  results: z.record(z.string(), artifactId),
}).strict()

export type WorkState = z.infer<typeof stateSchema>
export type StepState = z.infer<typeof stepState>

export const workRecordSchema = z.object({
  id: z.string(),
  events: z.array(eventSchema).min(1),
  state: stateSchema,
}).strict()

export type WorkRecord = z.infer<typeof workRecordSchema>

export const TERMINAL = new Set<WorkState['status']>(['succeeded', 'failed', 'held', 'cancelled'])

/** Fold events into state. Pure and total over valid event sequences. */
export function fold(stepIds: readonly string[], events: readonly WorkEvent[]): WorkState {
  const first = events[0]
  if (!first || first.type !== 'admitted') throw new TypeError('a Work record starts with its admission')
  const steps: Record<string, StepState> = Object.fromEntries(stepIds.map((stepId) => [stepId, { state: 'pending', attempts: [], outputs: {} }]))
  const state: WorkState = { status: 'running', specId: first.specId, input: first.input, criteria: { ...first.criteria }, steps, results: {} }
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
      case 'attempt-lost':
        steps[event.stepId]!.state = 'pending'
        break
      case 'reopened':
        for (const stepId of event.reset ?? []) {
          if (stepId === event.stepId) continue
          steps[stepId] = { state: 'pending', attempts: steps[stepId]!.attempts, outputs: {} }
        }
        steps[event.stepId]!.state = 'pending'
        steps[event.stepId]!.outputs = {}
        state.status = 'running'
        delete state.reason
        state.results = {}
        break
      case 'terminal':
        state.status = event.outcome
        state.reason = event.reason
        state.results = { ...event.results }
        break
    }
  }
  return state
}
