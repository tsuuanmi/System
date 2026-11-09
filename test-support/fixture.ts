/**
 * The deterministic concurrency fixture: a `WorkController` over in-memory
 * stand-ins, with fake Workers whose attempts are held at named barriers or
 * delayed by a seeded generator, so a seed reproduces an interleaving exactly.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Artifacts } from '@system/artifacts'
import { Host, TERMINAL, WorkController, Capabilities, parseWorkflow, resolve, type Admission, type SpecStore, type Verdict, type WorkRecord, type ResolvedSpec } from '@system/work'
import { memoryWorkTable } from './memory.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const turn = () => new Promise((resolve) => setImmediate(resolve))
const id = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

export const caller = { type: 'human', operatorId: 'tan' } as const

/** A Workflow file of workflows/ by name: what `resolve` reads the Sub-workflows a Workflow uses from. */
export const workflowFile = (name: string): string => readFileSync(join(repo, 'workflows', name), 'utf8')

/** mulberry32: the same seed gives the same sequence of numbers in [0, 1). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Fixture {
  controller: WorkController
  capabilities: Capabilities
  table: ReturnType<typeof memoryWorkTable>
  /** The step IDs of attempts started, in order. */
  attempts: string[]
  /** The most attempts of each Account (Worker ref) that ran at once. */
  peak: Record<string, number>
  /** Hold the attempts of `stepId` at its barrier until released. */
  hold(stepId: string): void
  /** Wait until `count` attempts of `stepId` are at its barrier. */
  arrived(stepId: string, count?: number): Promise<void>
  /** Let the attempts held at `stepId` go on. */
  release(stepId: string): void
  /** The most runs of the fake verifier that went at once. */
  checkPeak(): number
  /** The fake verifier's attempt IDs that were started. */
  checkAttempts: string[]
  /** Say that the process of an attempt is confirmed gone: its Account's Worker then reports it settled. */
  gone(attemptId: string): void
  /** Admit a Workflow file from workflows/ with a stored input. */
  admit(file: string): Promise<WorkRecord>
  /** The same admission, not yet submitted: what `Host.submit` takes. */
  admission(file: string): Admission
  /** What the fake publisher's `reconcile` reports about the remote. */
  remote: { state: 'applied' | 'absent' | 'unknown' }
  /** The verdicts the fake verifier gives next, in order; `pass` once they are used up. */
  verdicts: Verdict['verdict'][]
  /** A Workflow file of workflows/ by name, as the CLI sends the files a Workflow uses. */
  files(name: string): string
  /** Start a Host over this fixture's table, Artifacts and Workers, locked to `home`; `stallMinutes` as the Host takes it. */
  startHost(home: string, options?: { stallMinutes?: number }): Promise<Host>
}

/** The two Accounts of the fake Workers: Brainstorm's proposals use different ones, as the bundle's do. */
export const CLAUDE = 'fake/claude'
export const CODEX = 'fake/codex'
export const SPARE = 'fake/spare'

/**
 * With a `seed`, every attempt first yields a seeded number (0 to 8) of
 * event-loop turns. `slots` is each Account's `maxConcurrentAttempts`; `checks`
 * the fake verifier's `maxConcurrentChecks` (none: no limit).
 */
export function fixture(options: { seed?: number; slots?: number; checks?: number; spare?: boolean } = {}): Fixture {
  const random = options.seed === undefined ? undefined : seeded(options.seed)
  const stored = new Set<string>()
  const specs = new Map<string, ResolvedSpec>()
  const verdicts = new Map<string, Verdict>()
  const specStore: SpecStore = {
    unchangedBase: () => undefined,
    kindOf: (artifactId) => (verdicts.has(artifactId) ? 'verdict' : specs.has(artifactId) ? 'workflow-spec' : stored.has(artifactId) ? 'output' : undefined),
    async putVerdict(verdict) { const v = id(JSON.stringify(verdict)); verdicts.set(v, verdict); stored.add(v); return v },
    async putSpec(spec) { const s = id(JSON.stringify(spec)); specs.set(s, structuredClone(spec)); stored.add(s); return s },
    getSpec: (specId) => structuredClone(specs.get(specId)),
    exists: (artifactId) => stored.has(artifactId),
    taskOf: () => undefined,
    withNote: async () => { throw new Error('no Item in this test') },
  }
  const held = new Set<string>()
  const waiting = new Map<string, (() => void)[]>()
  const arrivals = new Map<string, { count: number; go: () => void }[]>()
  const arrived = new Map<string, number>()
  const goneAttempts = new Set<string>()
  const active: Record<string, number> = {}
  const peak: Record<string, number> = {}
  const attempts: string[] = []
  const checkAttempts: string[] = []
  let checking = 0
  let checkPeak = 0
  const delay = async () => { for (let n = Math.floor((random?.() ?? 0) * 9); n > 0; n--) await turn() }

  const remote: Fixture['remote'] = { state: 'absent' }
  const next: Verdict['verdict'][] = []
  const capabilities = new Capabilities()
  const worker = (ref: string, offered: string[]) => capabilities.registerWorker({
    ref,
    capabilities: offered,
    maxConcurrentAttempts: options.slots,
    async gone(attemptId) { return goneAttempts.has(attemptId) },
    async run(request) {
      attempts.push(request.stepId)
      active[ref] = (active[ref] ?? 0) + 1
      peak[ref] = Math.max(peak[ref] ?? 0, active[ref]!)
      try {
        await delay()
        if (held.has(request.stepId)) {
          arrived.set(request.stepId, (arrived.get(request.stepId) ?? 0) + 1)
          for (const waiter of arrivals.get(request.stepId) ?? []) if (arrived.get(request.stepId)! >= waiter.count) waiter.go()
          await new Promise<void>((go) => waiting.set(request.stepId, [...(waiting.get(request.stepId) ?? []), go]))
        }
        await delay()
        const outputs = Object.fromEntries(request.outputs.map((slot) => {
          const out = id(`${request.attemptId}/${slot}`)
          stored.add(out)
          return [slot, out]
        }))
        return { status: 'succeeded', outputs }
      } finally {
        active[ref]!--
      }
    },
  })
  worker(CLAUDE, ['code-write', 'research', 'web-search', 'brainstorm.idea-a', 'brainstorm.synthesis'])
  worker(CODEX, ['brainstorm.idea-b'])
  // A second Account offering what the first does, registered after it: the route for a step whose first capable Account is full.
  if (options.spare) worker(SPARE, ['brainstorm.idea-a'])
  capabilities.registerVerifier({
    ref: 'fake-verifier', version: '1', capabilities: ['code.required-checks', 'research.citation-check'], accepts: ['output'],
    ...(options.checks === undefined ? {} : { maxConcurrentChecks: options.checks }),
    async gone(attemptId) { return goneAttempts.has(attemptId) },
    async criteria(request) { const c = id(`criteria/${request.name}`); stored.add(c); return c },
    async verify(request) {
      checkAttempts.push(request.attemptId)
      checking++
      checkPeak = Math.max(checkPeak, checking)
      try {
        await delay()
        if (held.has(request.stepId)) {
          arrived.set(request.stepId, (arrived.get(request.stepId) ?? 0) + 1)
          for (const waiter of arrivals.get(request.stepId) ?? []) if (arrived.get(request.stepId)! >= waiter.count) waiter.go()
          await new Promise<void>((go) => waiting.set(request.stepId, [...(waiting.get(request.stepId) ?? []), go]))
        }
        const evidence = id(`evidence/${request.attemptId}`)
        stored.add(evidence)
        return { verdict: next.shift() ?? 'pass', reason: 'scripted', subject: request.subject, criteria: request.criteria, evidence: [evidence] }
      } finally {
        checking--
      }
    },
  })
  capabilities.registerEffect({
    ref: 'fake-publisher', version: '1', capabilities: ['git.publish'], accepts: ['output'],
    validate: () => undefined, approval: () => undefined,
    async apply(intent) { await delay(); return { state: 'applied', reason: 'published', detail: { subject: intent.subject } } },
    async reconcile() { return remote.state === 'applied' ? { state: 'applied', reason: 'scripted: applied', detail: {} } : { state: remote.state, reason: `scripted: ${remote.state}` } },
  })

  const table = memoryWorkTable()
  const controller = new WorkController(table, specStore, capabilities)
  return {
    controller, capabilities, table, attempts, checkAttempts, checkPeak: () => checkPeak, remote, peak, verdicts: next, files: workflowFile,
    hold: (stepId) => { held.add(stepId) },
    arrived: (stepId, count = 1) => ((arrived.get(stepId) ?? 0) >= count ? Promise.resolve() : new Promise<void>((go) => arrivals.set(stepId, [...(arrivals.get(stepId) ?? []), { count, go }]))),
    release: (stepId) => { held.delete(stepId); for (const go of waiting.get(stepId) ?? []) go(); waiting.delete(stepId) },
    gone: (attemptId) => { goneAttempts.add(attemptId) },
    admission(file) {
      const spec = resolve(parseWorkflow(workflowFile(file)), capabilities.available(), workflowFile)
      const input = id('the task')
      stored.add(input)
      return { spec, input, caller, source: { kind: 'workflow-file', path: file } }
    },
    admit(file) {
      return controller.admit(this.admission(file))
    },
    startHost: (home, more) => Host.start({ home, table, specs: specStore, capabilities, ...more }),
  }
}

/** The stored state is the fold of the events, and the event `seq` runs 0, 1, 2... with no gap or repeat. */
export function assertConsistent(f: Fixture, workId: string): void {
  assert.equal(f.controller.replay(workId).matches, true, `${workId}: the stored state differs from the fold of its events`)
  const seqs = f.controller.get(workId)!.events.map((e) => e.seq)
  assert.deepEqual(seqs, seqs.map((_, index) => index), `${workId}: event seq is missing or repeated`)
}

/** The Works of `host` with work left to do: after a start, the ones it found interrupted. */
export const unfinished = (host: Host): string[] => host.view.list().filter((r) => !TERMINAL.has(r.state.status)).map((r) => r.id)
