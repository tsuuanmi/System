/**
 * The Work record (ADR-0004 decision 9): one storage key per Work holding its
 * append-only events and the state they fold to. `fold(events)` is pure, so
 * replay of the recorded events always yields the stored state; replay never
 * re-runs a Worker, a verifier or an external effect.
 */
import { contentIdSchema } from '@system/artifacts'
import { z } from 'zod'
import { outsideNext, type OutsideRun } from './outside.ts'

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
/** The tool scope an attempt ran with: what its Runtime's flags and staged settings allowed (RES-0015). No token, no environment value. */
const scopeSchema = z.object({
  permissionMode: z.string().optional(), allowedTools: z.array(z.string()).optional(), disallowedTools: z.array(z.string()).optional(),
  /** Codex: the `-s` mode; Claude Code and Antigravity: whether the sandbox is on. */
  sandbox: z.union([z.string(), z.boolean()]).optional(),
  /** sha256 (hex) of the settings bytes the Runtime ran with. */
  settingsSha256: z.string().optional(),
}).strict()

const executorSchema = z.object({
  ref: z.string(), account: z.string().optional(), command: z.string().optional(), version: z.string().optional(),
  /** The tier the step asked for, the model configured for it, and the models the CLI reports it served. */
  tier: z.string().optional(), model: z.string().optional(), servedModels: z.array(z.string()).optional(),
  scope: scopeSchema.optional(),
}).strict()

/** usage-1: absent in records written before the outcome existed (`usageOutcome` derives it). */
const usageOutcomeFields = {
  outcome: z.enum(['known', 'partial', 'unavailable']).optional(), reason: z.string().optional(), origin: z.enum(['stream', 'transcript', 'none']).optional(),
}
const usageSchema = z.union([
  z.object({ state: z.literal('unknown'), ...usageOutcomeFields }).strict(),
  z.object({ state: z.literal('observed'), inputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative().optional(), cacheWriteTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative().optional(), source: z.string(), ...usageOutcomeFields }).strict(),
])

export type ExecutorRecord = z.infer<typeof executorSchema>
const known = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.literal('unknown')])
/** fl-4: what an attempt did, computed by System from its log; `unknown` where the Runtime's log does not say. */
const attemptSummarySchema = z.object({
  runtime: z.string(),
  toolCalls: known(z.record(z.string(), z.number().int().nonnegative())),
  filesRead: known(z.array(z.string())),
  filesEdited: known(z.array(z.string())),
  /** The longest tool calls, longest first; for Bash the first 120 characters of the command. */
  longest: z.array(z.object({ tool: z.string(), seconds: z.number().nonnegative(), command: z.string().optional() }).strict()),
  toolSeconds: known(z.number().nonnegative()),
  /** `toolSeconds` over the result's `duration_ms`: tool-seconds per second, not a share; parallel tool calls overlap, so it can pass 1. The name is kept for the records already written. */
  toolShare: known(z.number().nonnegative()),
  durationMs: known(z.number().nonnegative()),
  numTurns: known(z.number().int().nonnegative()),
}).strict()
export type AttemptSummary = z.infer<typeof attemptSummarySchema>

/** Why a port's failure is Outside, said by the port that wrote the reason (cause-1): only `outside.ts` reads it; an event without one is classified by its text, as old records are. */
const PORT_CAUSES = ['attach', 'conflict', 'load'] as const
export type PortCause = (typeof PORT_CAUSES)[number]
const portCause = z.enum(PORT_CAUSES).optional()

/** finish-1: structured final result reported by Codex and Antigravity attempts. */
const finalResultSchema = z.object({ status: z.enum(['done', 'blocked']), reason: z.string() }).strict()
export type FinalResult = z.infer<typeof finalResultSchema>

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
    /** fl-4: what the attempt did (tool calls, files, longest calls, tool share), computed by System from its log; absent in old records and for Runtimes with no log. */
    summary: attemptSummarySchema.optional(),
    /** finish-1: structured final result reported by Codex and Antigravity attempts. */
    finalResult: finalResultSchema.optional(),
    worker: executorSchema.optional(),
    /** Old records only: the attempt failed on a rate limit of its Account (the step stayed failed). */
    rateLimited: z.literal(true).optional(),
    /** The attempt failed because its Account is out of quota or credits: not a step failure; the step is dispatched again by routing. */
    limited: z.literal(true).optional(),
    /** The Worker says this failure may be tried afresh (`retry.onFail` names the step itself). */
    retryable: z.literal(true).optional(),
    /** The Worker's own marker of an Outside failure (the web attach). */
    cause: portCause,
    /** The controller's own failure: the step changed nothing. */
    noChange: z.literal(true).optional(),
    /** Old records only: never written (a later step's final message objected to an earlier step's output). */
    objection: z.string().optional(),
    /** A no-change attempt on a step reopened by this failing verdict, passed on as the same change (`retry.rerunUnchanged`): the check runs again on it. */
    unchangedAfter: contentIdSchema.optional(),
    /** tr-1: the existing tests the change modified or deleted (computed by System from git), each with the Worker's reason or "no reason given"; absent when none. */
    changedTests: z.array(z.object({ path: z.string(), change: z.enum(['modified', 'deleted']), reason: z.string() }).strict()).optional(),
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
    /** The Verifier's marker of an Outside verdict (the base re-run: `load`). */
    cause: portCause,
  }).strict(),
  z.object({
    /** A step whose `when`/`unless` condition on an optional output was not met: it does not run, and counts as done for the steps after it. */
    type: z.literal('skipped'), seq: z.number().int(), at,
    stepId: z.string(), reason: z.string(),
  }).strict(),
  z.object({
    /** Item qw-1: the step waits for an Account's quota to reset (`resetsAt` when known). Ended by the step's next `dispatched`; not a failure. */
    type: z.literal('waiting'), seq: z.number().int(), at,
    stepId: z.string(), cause: z.literal('quota'), resetsAt: z.string().optional(),
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
    rejected: z.enum(['conflict', 'merge-check', 'build-output']).optional(),
    /** The merge commit the provider held for an operator's Approval (`EffectOutcome.held`); recorded with state `absent`: nothing was published. */
    held: contentIdSchema.optional(),
    /** The provider's marker of an Outside failure (a conflict at publish). */
    cause: portCause,
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
    /** For `held`, why the controller held: `approval` (awaiting the operator's Approval) or `inconclusive` (a verdict needs a decision). */
    hold: z.enum(['approval', 'inconclusive']).optional(),
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
  /** Derived by `fold`: the step's latest `reopened` event; the Outside failures in a row on it (cm-2), absent when the last thing was not one. */
  reopening: z.object({ automatic: z.literal(true).optional(), failure: contentIdSchema.optional(), failedEffect: z.string().optional(), base: contentIdSchema.optional(), worker: z.string().optional(), previous: contentIdSchema.optional() }).strict().optional(),
  outside: z.custom<OutsideRun>((v) => typeof v === 'object').optional(),
  /** Derived by `fold`: the step waits on quota since the `waiting` event, until its next dispatch (qw-1). */
  waiting: z.object({ cause: z.literal('quota'), resetsAt: z.string().optional(), since: z.string() }).strict().optional(),
}).strict()

const effectState = z.object({
  stepId: z.string(),
  state: z.enum(['intended', 'applied', 'failed', 'absent', 'unknown']),
  detail: z.record(z.string(), z.string()).optional(),
  held: contentIdSchema.optional(),
  approvedMerge: contentIdSchema.optional(),
}).strict()

const stateSchema = z.object({
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
  verifiers: z.record(z.string(), z.object({ ref: z.string(), version: z.string() }).strict()).optional(),
  changedTests: z.record(z.string(), z.array(z.object({ path: z.string(), change: z.enum(['modified', 'deleted']), reason: z.string() }).strict())).optional(),
}).strict()

export type WorkState = z.infer<typeof stateSchema>
type StepState = z.infer<typeof stepState>

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
}).strict().transform((r) => ({ ...r, state: fold(Object.keys(r.state.steps), r.events) }))

export type WorkRecord = z.infer<typeof workRecordSchema>
export type Receipt = z.infer<typeof receipt>

export const TERMINAL = new Set<WorkState['status']>(TERMINAL_STATUSES)

/** Fold events into state. Pure and total over valid event sequences. */
export function fold(stepIds: readonly string[], events: readonly WorkEvent[]): WorkState {
  const first = events[0]
  if (!first || first.type !== 'admitted') throw new TypeError('a Work record starts with its admission')
  const steps: Record<string, StepState> = Object.fromEntries(stepIds.map((stepId) => [stepId, { state: 'pending', attempts: [], outputs: {} }]))
  const changedTests: NonNullable<WorkState['changedTests']> = {}
  const state: WorkState = { status: 'running', specId: first.specId, input: first.input, criteria: { ...first.criteria }, steps, effects: {}, results: {}, verifiers: { ...first.verifiers }, changedTests }
  for (const event of events.slice(1)) {
    switch (event.type) {
      case 'admitted':
        throw new TypeError('a Work is admitted once')
      case 'dispatched': {
        const s = steps[event.stepId]!
        s.state = 'running'
        s.attempts.push(event.attemptId)
        delete s.waiting
        break
      }
      case 'waiting':
        steps[event.stepId]!.waiting = { cause: event.cause, ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}), since: event.at }
        break
      case 'observed': {
        const s = steps[event.stepId]!
        if (event.limited) { s.state = 'pending'; break }
        s.state = event.status
        if (event.status === 'succeeded') s.outputs = { ...event.outputs }
        for (const subject of event.status === 'succeeded' ? Object.values(event.outputs) : []) if (event.changedTests || !changedTests[subject]) changedTests[subject] = event.changedTests ?? []
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
          const { attempts, reopening } = steps[stepId]!
          steps[stepId] = { state: 'pending', attempts, outputs: {}, ...(reopening ? { reopening } : {}) }
        }
        delete steps[event.stepId]!.waiting
        steps[event.stepId]!.state = 'pending'
        steps[event.stepId]!.outputs = {}
        steps[event.stepId]!.reopening = Object.fromEntries(Object.entries({ automatic: event.automatic, failure: event.failure, failedEffect: event.failedEffect, base: event.base, worker: event.worker, previous: event.previous }).filter(([, v]) => v !== undefined))
        // A verify step asked again: its last verdict is recorded and no longer counts.
        delete steps[event.stepId]!.verdict
        delete steps[event.stepId]!.subject
        delete steps[event.stepId]!.decision
        state.status = 'running'
        delete state.reason
        delete state.result
        state.results = {}
        break
      case 'effect-intended': {
        steps[event.stepId]!.state = 'running'
        const { held, approvedMerge } = state.effects[event.operationId] ?? {}
        state.effects[event.operationId] = { stepId: event.stepId, state: 'intended', ...(held && { held }), ...(approvedMerge && { approvedMerge }) }
        break
      }
      case 'effect-observed': {
        const effect = state.effects[event.operationId]!
        effect.state = event.state
        if (event.detail) effect.detail = { ...event.detail }
        if (event.held) { effect.held = event.held; delete effect.approvedMerge }
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
        for (const e of Object.values(state.effects)) if (e.stepId === event.stepId && e.held) event.decision === 'approved' ? e.approvedMerge = e.held : delete e.approvedMerge
        state.status = 'running'
        delete state.reason
        delete state.awaiting
        break
      case 'terminal':
        for (const step of Object.values(steps)) delete step.waiting
        state.status = event.outcome
        state.reason = event.reason
        state.results = { ...event.results }
        if (event.result) state.result = event.result
        if (event.awaiting) state.awaiting = event.awaiting
        break
    }
    for (const id of event.type === 'reopened' ? [event.stepId, ...(event.reset ?? [])] : 'stepId' in event ? [event.stepId] : []) {
      const run = outsideNext(steps[id]!.outside, event, id)
      if (run) steps[id]!.outside = run
      else delete steps[id]!.outside
    }
  }
  return state
}
