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
import { WorkController, Capabilities, parseWorkflow, resolve, type SpecStore, type Verdict, type WorkRecord, type ResolvedSpec } from '@system/work'
import { memoryWorkTable } from './memory.ts'
import { LocalControl } from './process.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const turn = () => new Promise((resolve) => setImmediate(resolve))
const id = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

export const caller = { type: 'human', operatorId: 'tan' } as const

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
  control: LocalControl
  table: ReturnType<typeof memoryWorkTable>
  /** The step IDs of attempts started, in order. */
  attempts: string[]
  /** Hold the attempts of `stepId` at its barrier until released. */
  hold(stepId: string): void
  /** Wait until an attempt of `stepId` is at its barrier. */
  arrived(stepId: string): Promise<void>
  /** Let the attempt held at `stepId` go on. */
  release(stepId: string): void
  /** Admit a Workflow file from workflows/ with a stored input. */
  admit(file: string): Promise<WorkRecord>
}

/** With a `seed`, every attempt first yields a seeded number (0 to 8) of event-loop turns. */
export function fixture(options: { seed?: number } = {}): Fixture {
  const random = options.seed === undefined ? undefined : seeded(options.seed)
  const stored = new Set<string>()
  const specs = new Map<string, ResolvedSpec>()
  const verdicts = new Map<string, Verdict>()
  const specStore: SpecStore = {
    kindOf: (artifactId) => (verdicts.has(artifactId) ? 'verdict' : specs.has(artifactId) ? 'workflow-spec' : stored.has(artifactId) ? 'output' : undefined),
    async putVerdict(verdict) { const v = id(JSON.stringify(verdict)); verdicts.set(v, verdict); stored.add(v); return v },
    async putSpec(spec) { const s = id(JSON.stringify(spec)); specs.set(s, structuredClone(spec)); stored.add(s); return s },
    getSpec: (specId) => structuredClone(specs.get(specId)),
    exists: (artifactId) => stored.has(artifactId),
  }
  const held = new Set<string>()
  const waiting = new Map<string, () => void>()
  const arrivals = new Map<string, () => void>()
  const arrived = new Set<string>()
  const attempts: string[] = []
  const delay = async () => { for (let n = Math.floor((random?.() ?? 0) * 9); n > 0; n--) await turn() }

  const capabilities = new Capabilities()
  capabilities.registerWorker({
    ref: 'fake',
    capabilities: ['code-write', 'research', 'web-search', 'brainstorm.idea-a', 'brainstorm.idea-b', 'brainstorm.synthesis'],
    async run(request) {
      attempts.push(request.stepId)
      await delay()
      if (held.has(request.stepId)) {
        arrived.add(request.stepId)
        arrivals.get(request.stepId)?.()
        await new Promise<void>((go) => waiting.set(request.stepId, go))
      }
      await delay()
      const outputs = Object.fromEntries(request.outputs.map((slot) => {
        const out = id(`${request.attemptId}/${slot}`)
        stored.add(out)
        return [slot, out]
      }))
      return { status: 'succeeded', outputs }
    },
  })
  capabilities.registerVerifier({
    ref: 'fake-verifier', version: '1', capabilities: ['code.required-checks', 'research.citation-check'], accepts: ['output'],
    async criteria(request) { const c = id(`criteria/${request.name}`); stored.add(c); return c },
    async verify(request) {
      await delay()
      const evidence = id(`evidence/${request.attemptId}`)
      stored.add(evidence)
      return { verdict: 'pass', reason: 'scripted', subject: request.subject, criteria: request.criteria, evidence: [evidence] }
    },
  })
  capabilities.registerEffect({
    ref: 'fake-publisher', version: '1', capabilities: ['git.publish'], accepts: ['output'],
    validate: () => undefined, approval: () => undefined,
    async apply(intent) { await delay(); return { state: 'applied', reason: 'published', detail: { subject: intent.subject } } },
    async reconcile() { return { state: 'absent', reason: 'nothing published' } },
  })

  const table = memoryWorkTable()
  const control = new LocalControl()
  const controller = new WorkController(table, specStore, capabilities, control)
  return {
    controller, control, table, attempts,
    hold: (stepId) => { held.add(stepId) },
    arrived: (stepId) => (arrived.has(stepId) ? Promise.resolve() : new Promise<void>((go) => arrivals.set(stepId, go))),
    release: (stepId) => { held.delete(stepId); waiting.get(stepId)?.(); waiting.delete(stepId) },
    async admit(file) {
      const spec = resolve(parseWorkflow(readFileSync(join(repo, 'workflows', file), 'utf8')), capabilities.available())
      const input = id('the task')
      stored.add(input)
      return controller.admit({ spec, input, caller, source: { kind: 'workflow-file', path: file } })
    },
  }
}

/** The stored state is the fold of the events, and the event `seq` runs 0, 1, 2... with no gap or repeat. */
export function assertConsistent(f: Fixture, workId: string): void {
  assert.equal(f.controller.replay(workId).matches, true, `${workId}: the stored state differs from the fold of its events`)
  const seqs = f.controller.get(workId)!.events.map((e) => e.seq)
  assert.deepEqual(seqs, seqs.map((_, index) => index), `${workId}: event seq is missing or repeated`)
}
