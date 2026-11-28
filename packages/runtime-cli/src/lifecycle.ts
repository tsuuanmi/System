/**
 * The Worker attempt lifecycle, written once for every Runtime (the CLI agents of agent.ts and the web Runtime): prepare
 * the workspace, enforce the time limit, map a cancel, store the whole log and prompt as Artifacts, capture the declared outputs
 * and shape the `WorkerResult`. A Runtime gives only its turn: run it, and say what came of it.
 *
 * The limit stops the turn through the same abort as an operator cancel (`TurnContext.signal`), so a Runtime has one path
 * to stop; what tells them apart is the result: a cancel is `cancelled`, anything else that stopped the turn is `failed`.
 * The order is: a cancel, then a stop the turn asked for (`ctx.stop`), then the time limit, then the turn's own failure,
 * then a declared output that is missing or empty.
 */
import type { Artifacts } from '@system/artifacts/contract'
import type { PortCause, UsageObserved, WorkerRequest, WorkerResult } from '@system/work'
import { redactLog, redactString, redactValue } from './redact.ts'
import { capture, cleanup, prepare, type Workspace } from './workspace.ts'

/** The wall-clock limit of an attempt when neither the account nor the row sets one. */
const DEFAULT_ATTEMPT_TIMEOUT_MINUTES = 60

/** What the lifecycle gives a turn. */
export interface TurnContext {
  ws: Workspace
  /** Aborts on a cancel, on the time limit and on `stop`. */
  signal: AbortSignal
  /** Stop the turn and fail the attempt with `reason` (the first one wins); a cancel still wins over it. */
  stop(reason: string): void
  /** Whether the time limit is what stopped the turn. */
  timedOut(): boolean
  /** Store bytes as an Artifact of this attempt (with the request's inputs when the lifecycle was given `inputs`). */
  put(data: Uint8Array, mediaType: string): Promise<string>
}

/** What a turn says came of it; every part is optional. A turn does not throw for a failure it can describe. */
interface TurnOutcome {
  /** The turn's own failure: the attempt fails with this reason. */
  failure?: string
  /** The marker of an Outside failure for `failure` (WorkerResult.cause). */
  cause?: PortCause
  message?: string
  usage?: Omit<UsageObserved, 'state'>
  usageGap?: string
  summary?: WorkerResult['summary']
  /** finish-1: structured final result when the Runtime reports one. */
  finalResult?: WorkerResult['finalResult']
  /** The outputs the turn stored itself; absent when the lifecycle captures `out/<slot>` files. */
  captured?: { outputs: Record<string, string>; missing: string[]; empty?: string[] }
  /** Extra partial outputs, kept whatever the status (and, alone, on success). */
  partial?: Record<string, string>
}

export type Turn = (ctx: TurnContext) => Promise<TurnOutcome>

interface AttemptOptions {
  artifacts: Artifacts
  /** The Worker's ref: the producer of the log, and the subject of the missing-output reason. */
  ref: string
  executor: NonNullable<WorkerResult['executor']>
  request: WorkerRequest
  /** The workspace directory. */
  dir: string
  /** The time limit; `DEFAULT_ATTEMPT_TIMEOUT_MINUTES` when absent. */
  timeoutMinutes?: number
  /** What a cancel says ("cancelled; the agent was stopped"). */
  cancelReason: string
  /** What a declared output is called in the missing-output reason; `file` by default. */
  outputNoun?: 'file' | 'block'
  /** Whether the lifecycle captures `out/<slot>` files when the turn reports none of its own; true by default. */
  files?: boolean
  /** The log as the turn has it so far, read after `settle`; stored whole (redacted). */
  log: () => string
  logMediaType?: string
  /** The prompt given to the Worker for this attempt, read after `settle` and stored redacted as an Artifact. */
  prompt?: () => string | undefined
  /** Inputs recorded on the Artifacts the lifecycle (and `ctx.put`) stores. */
  inputs?: string[]
  /** Values masked wherever they appear in the log, the prompt, the reason and the summary: the Account's own token (Item redact-1). */
  secrets?: readonly (string | undefined)[]
  /** Runs once the result is known and before the log is read: end the Runtime's resources, record what it saw; returns more partial outputs. */
  settle?: (result: Omit<WorkerResult, 'executor' | 'log' | 'prompt'>) => Promise<Record<string, string> | void>
  /** Runs last, before the workspace is cleaned, whatever happened. */
  teardown?: () => Promise<void>
  turn: Turn
}

export async function runAttempt(o: AttemptOptions): Promise<WorkerResult> {
  const { request } = o
  const limit = o.timeoutMinutes ?? DEFAULT_ATTEMPT_TIMEOUT_MINUTES
  const stopper = new AbortController()
  const forward = () => stopper.abort()
  if (request.signal.aborted) forward()
  request.signal.addEventListener('abort', forward, { once: true })
  let timedOut = false
  let stoppedFor: string | undefined
  const timer = setTimeout(() => { timedOut = true; forward() }, limit * 60_000)
  const producer = { type: 'worker' as const, ref: o.ref }
  const put = async (data: Uint8Array, mediaType: string) => (await o.artifacts.putBytes({
    kind: 'file', schemaVersion: 1, ...(o.inputs ? { inputs: o.inputs } : {}), data, mediaType,
    classification: 'local-private', producer, workId: request.workId, attemptId: request.attemptId,
  })).id
  let ws: Workspace | undefined
  try {
    ws = await prepare(o.artifacts, request, o.dir)
    const ctx: TurnContext = { ws, signal: stopper.signal, stop: (reason) => { stoppedFor ??= reason; forward() }, timedOut: () => timedOut, put }
    const outcome = await o.turn(ctx)
    const captured = outcome.captured ?? (o.files === false ? undefined : await capture(o.artifacts, ws, request, o.ref))
    const partial = { ...captured?.outputs, ...outcome.partial }
    const kept = captured || Object.keys(partial).length ? { partial } : {}
    // A stopped turn's output is incomplete, so its usage is unknown rather than a partial count.
    const stopped = (reason: string, status: WorkerResult['status']): Omit<WorkerResult, 'executor' | 'log' | 'prompt'> => ({ status, outputs: {}, ...kept, reason, usageGap: 'the attempt was stopped before the Runtime reported usage', ...(outcome.summary ? { summary: outcome.summary } : {}) })
    const noun = o.outputNoun ?? 'file'
    let result: Omit<WorkerResult, 'executor' | 'log' | 'prompt'>
    if (request.signal.aborted) result = stopped(o.cancelReason, 'cancelled')
    else if (stoppedFor) result = stopped(stoppedFor, 'failed')
    else if (timedOut) result = stopped(`attempt exceeded its time limit of ${limit} minutes`, 'failed')
    else {
      const common = { ...(outcome.summary ? { summary: outcome.summary } : {}), ...(outcome.finalResult ? { finalResult: outcome.finalResult } : {}), ...(outcome.usage ? { usage: outcome.usage } : outcome.usageGap ? { usageGap: outcome.usageGap } : {}) }
      if (outcome.failure !== undefined) result = { status: 'failed', outputs: {}, ...kept, reason: outcome.failure, ...(outcome.cause ? { cause: outcome.cause } : {}), ...common }
      else if (captured?.missing.length) result = { status: 'failed', outputs: {}, ...kept, reason: `${o.ref} wrote no output ${noun} for ${captured.missing.join(', ')}`, retryable: true, ...common }
      else if (captured?.empty?.length) result = { status: 'failed', outputs: {}, ...kept, reason: `${o.ref} wrote an empty output ${noun}: ${captured.empty.map((slot) => `output ${slot} is empty`).join(', ')}`, retryable: true, ...common }
      else result = { status: 'succeeded', outputs: captured?.outputs ?? {}, ...(outcome.partial ? { partial: outcome.partial } : {}), ...(outcome.message ? { message: outcome.message } : {}), ...common }
    }
    // Item redact-1: what is stored or recorded of the attempt carries no secret.
    if (result.reason !== undefined) result.reason = redactString(result.reason, o.secrets)
    if (result.summary) result.summary = redactValue(result.summary, o.secrets)
    const more = await o.settle?.(result)
    if (more) result.partial = { ...result.partial, ...more }
    const log = await put(Buffer.from(redactLog(o.log(), o.secrets)), o.logMediaType ?? 'application/x-ndjson')
    const rawPrompt = o.prompt?.()
    const prompt = rawPrompt !== undefined ? await put(Buffer.from(redactLog(rawPrompt, o.secrets)), 'text/plain') : undefined
    return { ...result, log, ...(prompt ? { prompt } : {}), executor: o.executor }
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', forward)
    await o.teardown?.()
    if (ws) await cleanup(ws)
  }
}
