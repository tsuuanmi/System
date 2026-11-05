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
  /** Aborted when the operator cancels; the Worker stops and reports `cancelled`. */
  signal: AbortSignal
}

export interface WorkerResult {
  status: 'succeeded' | 'failed' | 'cancelled'
  /** Output slot -> Artifact ID; every declared slot on success. */
  outputs: Record<string, string>
  /** What a cancelled or failed attempt left behind; never accepted. */
  partial?: Record<string, string>
  reason?: string
  usage?: { inputTokens: number; outputTokens: number; source: string }
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
  run(request: WorkerRequest): Promise<WorkerResult>
}

export interface VerifyRequest {
  workId: string
  attemptId: string
  stepId: string
  capability: string
  subject: string
  criteria: string
}

export interface VerifyResult {
  verdict: 'pass' | 'fail' | 'inconclusive' | 'error'
  reason: string
  verdictId?: string
}

export interface VerifierPort {
  ref: string
  capabilities: readonly string[]
  verify(request: VerifyRequest): Promise<VerifyResult>
}

export interface Route<P> {
  selected?: P
  candidates: { ref: string; selected: boolean; reason: string }[]
}

export class Capabilities {
  private readonly workers: WorkerPort[] = []
  private readonly verifiers: VerifierPort[] = []

  registerWorker(port: WorkerPort): () => void {
    this.workers.push(port)
    return () => { this.workers.splice(this.workers.indexOf(port), 1) }
  }

  registerVerifier(port: VerifierPort): () => void {
    this.verifiers.push(port)
    return () => { this.verifiers.splice(this.verifiers.indexOf(port), 1) }
  }

  available(): AvailableCapabilities {
    return {
      workers: new Set(this.workers.flatMap((w) => w.capabilities)),
      verifiers: new Set(this.verifiers.flatMap((v) => v.capabilities)),
    }
  }

  /**
   * The first registered Worker with every needed capability; every candidate's reason is kept.
   * `only`: a takeover names the one Worker allowed (`system work retry --worker`).
   */
  routeWorker(needs: readonly string[], only?: string): Route<WorkerPort> {
    return route(this.workers, needs, only)
  }

  workerRefs(): string[] {
    return this.workers.map((w) => w.ref)
  }

  routeVerifier(capability: string): Route<VerifierPort> {
    return route(this.verifiers, [capability])
  }
}

function route<P extends { ref: string; capabilities: readonly string[] }>(ports: readonly P[], needs: readonly string[], only?: string): Route<P> {
  let selected: P | undefined
  const candidates = ports.map((port) => {
    const missing = needs.filter((c) => !port.capabilities.includes(c))
    if (only !== undefined && port.ref !== only) return { ref: port.ref, selected: false, reason: `the takeover names ${only}` }
    if (missing.length) return { ref: port.ref, selected: false, reason: `lacks ${missing.join(', ')}` }
    if (selected) return { ref: port.ref, selected: false, reason: `capable; ${selected.ref} registered first` }
    selected = port
    return { ref: port.ref, selected: true, reason: `provides ${needs.join(', ')}` }
  })
  return { selected, candidates }
}
