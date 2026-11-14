/**
 * Capability registry: Worker and verifier rows register here; admission and
 * routing read it. Routing is by capability, never by domain or vendor.
 */
import { DEFAULT_QUOTA_CEILING_PERCENT, rankByHeadroom, type QuotaReading } from './headroom.ts'
import type { ExecutorRecord, UsageObserved } from './record.ts'
import type { AvailableCapabilities } from './workflow.ts'

/** What a Worker gets for one attempt: exact Artifact IDs only, no transcript. */
export interface WorkerRequest {
  workId: string
  attemptId: string
  stepId: string
  capabilities: string[]
  inputs: Record<string, string>
  outputs: string[]
  /** Outputs the Worker may leave out: written only when they apply (the step's `optionalOutputs`). Absent when the step has none. */
  optionalOutputs?: string[]
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
  /** A failure that may be tried afresh: it happened before anything was sent that cannot be sent again. The Worker decides; the Workflow's `retry` says whether to. */
  retryable?: true
  /** The Worker's own final message, if it gave one; the controller quotes it when it fails the step itself. */
  message?: string
  usage?: Omit<UsageObserved, 'state'>
  /** Bounded agent output as an Artifact, for audit. */
  log?: string
  executor?: ExecutorRecord
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
  /** The share of a quota window (percent used) from which the Account is not chosen; default 80. The row's `quotaCeilingPercent`. */
  quotaCeilingPercent?: number
  /** The Account's quota windows (a cached read, no model turn); absent for an Account with none (`web`), which ranks after every readable one. */
  quota?(fresh?: boolean): Promise<QuotaReading>
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
  /** Evidence IDs of the verdicts this verify step gave earlier in the Work that were not a `pass`, oldest first. */
  earlier?: string[]
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
  /** How many runs of this verifier go at once on the machine (the Host's check slots); absent: no limit. */
  maxConcurrentChecks?: number
  /** Whether the process of a run is confirmed gone: what settles a lost run, which until then keeps its check slot. Absent: never confirmed. */
  gone?(attemptId: string): Promise<boolean>
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
  required?: { capability: string; criteria: string; verifier?: { ref: string; version: string } }[]
  /** The merge commit (a git-tree Artifact) an operator approved after the provider held it (`EffectOutcome.held`): that commit goes in without a re-check. An approval of another commit is none. */
  approvedMerge?: string
  /** tr-1: the existing tests the published change modified or deleted, from the Work record (not part of the recorded intent); a provider that writes a description lists them. Absent when the record holds no list for the subject, empty when the change touched no test. */
  changedTests?: { path: string; change: 'modified' | 'deleted'; reason: string }[]
}

export interface EffectOutcome {
  state: 'applied' | 'failed'
  /** Set only on a `failed` outcome the remote observed as a refusal that a new change on a newer base can fix; `detail.base` is then the git-tree Artifact of the base tip. Never set for an unknown outcome or other failures. */
  rejected?: 'conflict' | 'merge-check'
  /** Set on a `failed` outcome that holds the Work: the merge commit (a git-tree Artifact) that needs an operator's Approval, because its re-check was inconclusive or its verifier changed since admission. Nothing was published. */
  held?: string
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
  /** Some port is capable, but none has a free slot: the step waits for one instead of failing. */
  full?: boolean
  /** Every capable Account with a free slot is over its quota ceiling: the step waits (until `resetsAt`, if known) without failing. */
  quotaWait?: { resetsAt?: string }
}

const add = <P>(list: P[], port: P): (() => void) => {
  list.push(port)
  return () => { list.splice(list.indexOf(port), 1) }
}

export class Capabilities {
  private readonly workers: WorkerPort[] = []
  private readonly verifiers: VerifierPort[] = []
  private readonly effects: EffectPort[] = []

  registerWorker(port: WorkerPort): () => void {
    return add(this.workers, port)
  }

  registerVerifier(port: VerifierPort): () => void {
    return add(this.verifiers, port)
  }

  registerEffect(port: EffectPort): () => void {
    return add(this.effects, port)
  }

  available(): AvailableCapabilities {
    return {
      workers: new Set(this.workers.flatMap((w) => w.capabilities)),
      verifiers: new Set(this.verifiers.flatMap((v) => v.capabilities)),
      effects: new Set(this.effects.flatMap((e) => e.capabilities)),
    }
  }

  /**
   * The Worker for a step: capable (every capability needed), allowed and, when `free` is given, with a free slot; every candidate's reason is kept.
   * Among those, `rankByHeadroom` over `readings` (the quota of each Account that has one, read by the caller): the most headroom, unreadable and quota-less Accounts last;
   * ties, those Accounts included, go to the fewest `attempts` that UTC day, then registration order. Without readings that is the first registered.
   * `only`: the one Worker allowed (`system work submit --worker`, or a takeover by `system work retry --worker`).
   * `limited`: Accounts that just failed an attempt on quota or credits are passed over (reason `limited: ...`), and the step waits when no other is left.
   * Capable Workers but none free: `selected` is absent and `full` is set. All free ones over the ceiling: `selected` is absent and `quotaWait` is set.
   */
  routeWorker(needs: readonly string[], only?: string, free?: (worker: WorkerPort) => boolean, readings: ReadonlyMap<string, QuotaReading> = new Map(), limited: ReadonlySet<string> = new Set(), attempts: ReadonlyMap<string, number> = new Map(), prefer?: string): Route<WorkerPort> {
    const rankable = this.rankable(needs, only, free)
    const passedOver = rankable.filter((w) => limited.has(w.ref))
    const rank = (ws: WorkerPort[]) => rankByHeadroom(ws.map((w) => ({ ref: w.ref, attempts: attempts.get(w.ref) ?? 0, reading: readings.get(w.ref), ceiling: w.quotaCeilingPercent ?? DEFAULT_QUOTA_CEILING_PERCENT })))
    const pool = rankable.filter((w) => !limited.has(w.ref))
    // A preferred capability (ro-12): rank the Accounts that have it alone, if one of them can take the step now.
    const preferred = prefer ? pool.filter((w) => w.capabilities.includes(prefer)) : []
    const first = preferred.length ? rank(preferred) : undefined
    const ranking = first?.selected ? first : rank(pool)
    let full = false
    const candidates = this.workers.map((w) => {
      const missing = needs.filter((c) => !w.capabilities.includes(c))
      if (only !== undefined && w.ref !== only) return { ref: w.ref, selected: false, reason: `only ${only} is allowed` }
      if (missing.length) return { ref: w.ref, selected: false, reason: `lacks ${missing.join(', ')}` }
      if (!rankable.includes(w)) { full = true; return { ref: w.ref, selected: false, reason: 'capable; no free slot' } }
      if (limited.has(w.ref)) return { ref: w.ref, selected: false, reason: 'limited: out of credits or quota (read again later)' }
      const reason = ranking.reasons[w.ref] ?? `capable; ${prefer} Account preferred`
      return { ref: w.ref, selected: ranking.selected === w.ref, reason }
    })
    const selected = rankable.find((w) => w.ref === ranking.selected)
    return { selected, candidates, ...(!selected && ranking.waitUntil ? { quotaWait: ranking.waitUntil } : !selected && passedOver.length ? { quotaWait: {} } : !selected && full ? { full } : {}) }
  }

  /** The Workers `routeWorker` ranks: capable, allowed, and with a free slot when `free` is given. */
  rankable(needs: readonly string[], only?: string, free?: (worker: WorkerPort) => boolean): WorkerPort[] {
    return this.workers.filter((w) => (only === undefined || w.ref === only) && needs.every((c) => w.capabilities.includes(c)) && (!free || free(w)))
  }

  /** The Worker (Account) of a ref. */
  workerFor(ref: string): WorkerPort | undefined {
    return this.workers.find((w) => w.ref === ref)
  }

  verifierFor(ref: string): VerifierPort | undefined {
    return this.verifiers.find((v) => v.ref === ref)
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

function route<P extends { ref: string; capabilities: readonly string[] }>(ports: readonly P[], needs: readonly string[]): Route<P> {
  let selected: P | undefined
  const candidates = ports.map((port) => {
    const missing = needs.filter((c) => !port.capabilities.includes(c))
    if (missing.length) return { ref: port.ref, selected: false, reason: `lacks ${missing.join(', ')}` }
    if (selected) return { ref: port.ref, selected: false, reason: `capable; ${selected.ref} registered first` }
    selected = port
    return { ref: port.ref, selected: true, reason: `provides ${needs.join(', ')}` }
  })
  return { selected, candidates }
}
