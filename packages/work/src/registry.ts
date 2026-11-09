/**
 * Capability registry: Worker and verifier rows register here; admission and
 * routing read it. Routing is by capability, never by domain or vendor.
 */
import type { AvailableCapabilities } from './workflow.ts'

/** What a Worker gets for one attempt: exact Artifact IDs only, no transcript. */
export interface WorkerRequest {
  workId: string
  attemptId: string
  stepId: string
  capabilities: string[]
  inputs: Record<string, string>
  outputs: string[]
  /** The Workflow step's own instructions, if it has any. */
  instructions?: string
  /** Aborted when the operator cancels; the Worker stops and reports `cancelled`. */
  signal: AbortSignal
  /** Report what the attempt has done so far; each call is activity. Kept in memory by the Host, never recorded. */
  progress?: (progress: Progress) => void
}

/** What a running attempt reports of itself, as far as its Runtime tells. */
export interface Progress {
  turns?: number
  lastTool?: string
  /** Tokens so far: fresh input, cache writes and output. */
  tokens?: number
  /** Input tokens so far, cache reads included: what a long wait re-reads (PROP-0007 decision 2). */
  inputTokens?: number
  /** Where an attempt with stages is, such as a web Runtime's evidence stage. */
  stage?: string
}

export interface WorkerResult {
  status: 'succeeded' | 'failed' | 'cancelled'
  /** Output slot -> Artifact ID; every declared slot on success. */
  outputs: Record<string, string>
  /** What a cancelled or failed attempt left behind; never accepted. */
  partial?: Record<string, string>
  reason?: string
  usage?: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens: number; costUsd?: number; source: string }
  /** Bounded agent output as an Artifact, for audit. */
  log?: string
  executor?: { ref: string; account?: string; command?: string; version?: string; tier?: string; model?: string; servedModels?: string[] }
}

/** Model tiers, as System 1 names them (ADR-0073 there): a step asks for one as capability `tier.<name>`. */
export const TIERS = ['economy', 'standard', 'frontier'] as const
export type Tier = (typeof TIERS)[number]
export const tierCapability = (tier: Tier) => `tier.${tier}`

/** The tier a step's capabilities ask for, if any. */
export function requestedTier(capabilities: readonly string[]): Tier | undefined {
  return TIERS.find((tier) => capabilities.includes(tierCapability(tier)))
}

export interface WorkerPort {
  /** A stable name, recorded in routing decisions. */
  ref: string
  capabilities: readonly string[]
  /** How many attempts of this Account run at once; default 1. */
  maxConcurrentAttempts?: number
  /** Whether the process of an attempt is confirmed gone: what settles a lost attempt, which until then keeps its Account's slot. Absent: never confirmed. */
  gone?(attemptId: string): Promise<boolean>
  run(request: WorkerRequest): Promise<WorkerResult>
}

export interface VerifyRequest {
  workId: string
  attemptId: string
  stepId: string
  capability: string
  /** The exact subject Artifact ID. */
  subject: string
  /** The criteria Artifact ID pinned at admission. */
  criteria: string
  /** Further exact Artifact IDs the step names (`verify.inputs`), by slot. */
  inputs?: Record<string, string>
}

/**
 * A verdict and what it is about. The controller refuses (`error`) a result
 * whose subject or criteria differ from the request, a `pass` without
 * evidence, and evidence that is not stored; it then stores the `verdict@1`
 * Artifact itself (ADR-0003 decisions 6 and 8).
 */
export interface VerifyResult {
  verdict: 'pass' | 'fail' | 'inconclusive' | 'error'
  reason: string
  subject: string
  criteria: string
  /** Stored Artifact IDs supporting the verdict. */
  evidence: string[]
}

export interface CriteriaRequest {
  capability: string
  /** The criteria name the Workflow file gives. */
  name: string
  /** The Work's input Artifact, if any (a task naming a repository, ...). */
  input?: string
  operatorId: string
}

export interface VerifierPort {
  ref: string
  version: string
  capabilities: readonly string[]
  /** Subject Artifact kinds it can judge; anything else is an `error` verdict, never a pass. */
  accepts: readonly string[]
  /** Pin the named criteria for one Work at admission, as an Artifact; throws to refuse admission. */
  criteria(request: CriteriaRequest): Promise<string>
  verify(request: VerifyRequest): Promise<VerifyResult>
}

/**
 * One external effect, identified by `operationId` (stable for a Work, step
 * and subject). A provider applies it at most once per operation: before any
 * retry after an unknown outcome, the controller calls `reconcile`, which
 * only reads (ADR-0004 decision 10, MVP-03).
 */
export interface EffectIntent {
  operationId: string
  workId: string
  stepId: string
  capability: string
  /** The exact Artifact ID the effect publishes. */
  subject: string
  params: Record<string, string | number | boolean>
  /** The verify steps the effect requires, with their pinned criteria: what a provider runs again on a commit it makes, such as a merge. */
  required?: { capability: string; criteria: string }[]
}

export interface EffectOutcome {
  state: 'applied' | 'failed'
  reason: string
  /** What the remote side now holds, such as a branch, commit and pull request. */
  detail: Record<string, string>
}

export type Reconciled =
  | { state: 'applied'; reason: string; detail: Record<string, string> }
  | { state: 'absent'; reason: string }
  | { state: 'unknown'; reason: string }

export interface EffectPort {
  ref: string
  version: string
  capabilities: readonly string[]
  /** Subject Artifact kinds it can publish. */
  accepts: readonly string[]
  /** Refuse admission for parameters or a configuration it cannot honour. */
  validate(capability: string, params: EffectIntent['params']): void
  /** Why this intent needs an operator's approval, or `undefined` when it is routine. */
  approval(intent: EffectIntent): string | undefined
  apply(intent: EffectIntent): Promise<EffectOutcome>
  reconcile(intent: EffectIntent): Promise<Reconciled>
}

export interface Route<P> {
  selected?: P
  candidates: { ref: string; selected: boolean; reason: string }[]
}

export class Capabilities {
  private readonly workers: WorkerPort[] = []
  private readonly verifiers: VerifierPort[] = []
  private readonly effects: EffectPort[] = []

  registerWorker(port: WorkerPort): () => void {
    this.workers.push(port)
    return () => { this.workers.splice(this.workers.indexOf(port), 1) }
  }

  registerVerifier(port: VerifierPort): () => void {
    this.verifiers.push(port)
    return () => { this.verifiers.splice(this.verifiers.indexOf(port), 1) }
  }

  registerEffect(port: EffectPort): () => void {
    this.effects.push(port)
    return () => { this.effects.splice(this.effects.indexOf(port), 1) }
  }

  available(): AvailableCapabilities {
    return {
      workers: new Set(this.workers.flatMap((w) => w.capabilities)),
      verifiers: new Set(this.verifiers.flatMap((v) => v.capabilities)),
      effects: new Set(this.effects.flatMap((e) => e.capabilities)),
    }
  }

  /**
   * The first registered Worker with every needed capability; every candidate's reason is kept.
   * `only`: the one Worker allowed (`system work submit --worker`, or a takeover by `system work retry --worker`).
   */
  routeWorker(needs: readonly string[], only?: string): Route<WorkerPort> {
    return route(this.workers, needs, only)
  }

  /** The Worker (Account) of a ref. */
  workerFor(ref: string): WorkerPort | undefined {
    return this.workers.find((w) => w.ref === ref)
  }

  workerRefs(): string[] {
    return this.workers.map((w) => w.ref)
  }

  routeVerifier(capability: string): Route<VerifierPort> {
    return route(this.verifiers, [capability])
  }

  routeEffect(capability: string): Route<EffectPort> {
    return route(this.effects, [capability])
  }
}

function route<P extends { ref: string; capabilities: readonly string[] }>(ports: readonly P[], needs: readonly string[], only?: string): Route<P> {
  let selected: P | undefined
  const candidates = ports.map((port) => {
    const missing = needs.filter((c) => !port.capabilities.includes(c))
    if (only !== undefined && port.ref !== only) return { ref: port.ref, selected: false, reason: `only ${only} is allowed` }
    if (missing.length) return { ref: port.ref, selected: false, reason: `lacks ${missing.join(', ')}` }
    if (selected) return { ref: port.ref, selected: false, reason: `capable; ${selected.ref} registered first` }
    selected = port
    return { ref: port.ref, selected: true, reason: `provides ${needs.join(', ')}` }
  })
  return { selected, candidates }
}
