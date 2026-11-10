import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { memoryWorkTable } from '../../../test-support/memory.ts'
import { WorkController, type SpecStore, type WorkTable } from '../src/controller.ts'
import { WorkError } from '../src/errors.ts'
import { fold, type WorkRecord } from '../src/record.ts'
import type { Verdict } from '../src/kinds.ts'
import { Capabilities, type VerifierPort, type VerifyResult, type WorkerPort, type WorkerRequest, type WorkerResult } from '../src/registry.ts'
import { WorkflowError, directTask, parseWorkflow, resolve, type ResolvedSpec } from '../src/workflow.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const fixture = (name: string) => readFileSync(join(repo, 'workflows', name), 'utf8')
const caller = { type: 'human', operatorId: 'tan' } as const
const id = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

function memorySpecs(): SpecStore & { stored: Set<string>; verdicts: Map<string, Verdict>; unchanged: Map<string, string> } {
  const unchanged = new Map<string, string>()
  const specs = new Map<string, ResolvedSpec>()
  const stored = new Set<string>()
  const verdicts = new Map<string, Verdict>()
  return {
    stored,
    verdicts,
    unchanged,
    unchangedBase: (artifactId) => unchanged.get(artifactId),
    kindOf: (artifactId) => (verdicts.has(artifactId) ? 'verdict' : specs.has(artifactId) ? 'workflow-spec' : stored.has(artifactId) ? 'output' : undefined),
    async putVerdict(verdict) {
      const verdictId = id(JSON.stringify(verdict))
      verdicts.set(verdictId, verdict)
      stored.add(verdictId)
      return verdictId
    },
    async putSpec(spec) {
      const specId = id(JSON.stringify(spec))
      specs.set(specId, structuredClone(spec))
      stored.add(specId)
      return specId
    },
    getSpec: (specId) => structuredClone(specs.get(specId)),
    exists: (artifactId) => stored.has(artifactId),
    taskOf: () => undefined,
    withNote: async () => { throw new Error('no Item in this test') },
  }
}

interface Harness {
  controller: WorkController
  capabilities: Capabilities
  calls: WorkerRequest[]
  verdicts: string[]
  table: ReturnType<typeof memoryWorkTable>
  specs: ReturnType<typeof memorySpecs>
}

function harness(options: { verdict?: VerifyResult['verdict']; worker?: Partial<WorkerPort>; verifier?: Partial<VerifierPort>; table?: WorkTable; specs?: ReturnType<typeof memorySpecs> } = {}): Harness {
  // Tests that read `table.rows` pass no table; the snapshot tests read their own `disk`.
  const table = (options.table ?? memoryWorkTable()) as ReturnType<typeof memoryWorkTable>
  const specs = options.specs ?? memorySpecs()
  const capabilities = new Capabilities()
  const calls: WorkerRequest[] = []
  const verdicts: string[] = []
  capabilities.registerWorker({
    ref: 'fake',
    capabilities: ['code-write', 'research', 'web-search', 'tier.standard', 'tier.economy'],
    async run(request) {
      calls.push(request)
      const outputs = Object.fromEntries(request.outputs.map((slot) => {
        const out = id(`${request.attemptId}/${slot}`)
        specs.stored.add(out)
        return [slot, out]
      }))
      return { status: 'succeeded', outputs }
    },
    ...options.worker,
  })
  capabilities.registerVerifier({
    ref: 'fake-verifier',
    version: '1',
    capabilities: ['code.required-checks', 'research.citation-check'],
    accepts: ['output'],
    async criteria(request) {
      const criteria = id(`criteria/${request.name}`)
      specs.stored.add(criteria)
      return criteria
    },
    async verify(request) {
      verdicts.push(`${request.stepId}:${request.subject}`)
      const evidence = id(`evidence/${request.attemptId}`)
      specs.stored.add(evidence)
      return { verdict: options.verdict ?? 'pass', reason: 'scripted', subject: request.subject, criteria: request.criteria, evidence: [evidence] }
    },
    ...options.verifier,
  })
  capabilities.registerEffect({
    ref: 'fake-publisher', version: '1', capabilities: ['git.publish'], accepts: ['output'],
    validate: () => undefined, approval: () => undefined,
    async apply(intent) { return { state: 'applied', reason: 'published', detail: { subject: intent.subject } } },
    async reconcile() { return { state: 'absent', reason: 'nothing published' } },
  })
  return { controller: new WorkController(table, specs, capabilities), capabilities, calls, verdicts, table, specs }
}

async function input(h: Harness): Promise<string> {
  const artifactId = id('the task')
  h.specs.stored.add(artifactId)
  return artifactId
}

async function runFixture(h: Harness, name: string) {
  const spec = resolve(parseWorkflow(fixture(name)), h.capabilities.available(), fixture)
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file', path: name } })
  return h.controller.run(admitted.id)
}

test('a verify step\'s further inputs reach the verifier as exact Artifact IDs (the report beside the sources)', async () => {
  const seen: Record<string, string>[] = []
  const h = harness({ verifier: { async verify(request) {
    seen.push(request.inputs ?? {})
    const evidence = id(`evidence/${request.attemptId}`)
    h.specs.stored.add(evidence)
    return { verdict: 'pass', reason: 'scripted', subject: request.subject, criteria: request.criteria, evidence: [evidence] }
  } } })
  const done = await runFixture(h, 'research.yaml')
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(seen, [{ report: done.state.steps.investigate!.outputs.report! }])
})

/** A Worker whose every output is stored; the ones in `same` are a git tree equal to its base commit. */
function treeWorker(h: () => Harness, same: (slot: string) => boolean, message?: string): Partial<WorkerPort> {
  return {
    async run(request) {
      const outputs = Object.fromEntries(request.outputs.map((slot) => {
        const out = id(`${request.attemptId}/${slot}`)
        h().specs.stored.add(out)
        if (same(slot)) h().specs.unchanged.set(out, 'abcdef0123456789')
        return [slot, out]
      }))
      return { status: 'succeeded', outputs, ...(message ? { message } : {}) }
    },
  }
}

test('a code-write step whose change is its base tree fails with "no change", quoting the Worker\'s message', async () => {
  const h: Harness = harness({ worker: treeWorker(() => h, () => true, `I looked\nand found  nothing to do ${'x'.repeat(400)}`) })
  const done = await runFixture(h, 'software-engineering.yaml')
  assert.equal(done.state.status, 'failed')
  assert.equal(done.state.steps.implement!.state, 'failed')
  const reason = done.events.findLast((e) => e.type === 'observed')
  assert.ok(reason?.type === 'observed' && reason.reason?.startsWith('no change: the working tree is the same as the base commit abcdef0. The Worker said: I looked and found nothing to do x'))
  assert.ok(reason.reason!.length < 400)
  assert.equal(h.verdicts.length, 0)
})

test('a step declared mayBeEmpty passes an unchanged tree on instead of failing', async () => {
  const h: Harness = harness({ worker: treeWorker(() => h, () => true) })
  const text = fixture('software-engineering.yaml').replace('    outputs: [change]\n', '    outputs: [change]\n    mayBeEmpty: true\n')
  assert.notEqual(text, fixture('software-engineering.yaml'))
  const spec = resolve(parseWorkflow(text), h.capabilities.available(), fixture)
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file', path: 'software-engineering.yaml' } })
  const done = await h.controller.run(admitted.id)
  assert.equal(done.state.steps.implement!.state, 'succeeded')
})

test('a changed tree still passes, and a read-only scout with an unchanged checkout still succeeds', async () => {
  const changed: Harness = harness({ worker: treeWorker(() => changed, () => false) })
  assert.equal((await runFixture(changed, 'software-engineering.yaml')).state.status, 'succeeded')
  const scouts: Harness = harness({ worker: treeWorker(() => scouts, (slot) => slot === 'checkout') })
  const spec = resolve(parseWorkflow(fixture('hygiene.yaml')), scouts.capabilities.available(), fixture)
  const scouting = spec.steps.filter((s) => 'outputs' in s && s.outputs[0] === 'checkout')
  assert.ok(scouting.length >= 4)
  const admitted = await scouts.controller.admit({ spec, input: await input(scouts), caller, source: { kind: 'workflow-file', path: 'hygiene.yaml' } })
  const done = await scouts.controller.run(admitted.id)
  for (const s of scouting) assert.equal(done.state.steps[s.id]!.state, 'succeeded', s.id)
})

test('a direct Task with no Workflow file runs one attempt to a result', async () => {
  const h = harness()
  const spec = directTask(['code-write'], false, h.capabilities.available())
  const admitted = await h.controller.admit({ spec, caller, source: { kind: 'direct-task' } })
  const done = await h.controller.run(admitted.id)
  assert.equal(done.state.status, 'succeeded')
  assert.equal(h.calls.length, 1)
  assert.deepEqual(Object.keys(done.state.results), ['task.result'])
})

test('Software Engineering and Research run through the same controller code', async () => {
  const h = harness()
  const se = await runFixture(h, 'software-engineering.yaml')
  const research = await runFixture(h, 'research.yaml')
  assert.equal(se.state.status, 'succeeded')
  assert.equal(research.state.status, 'succeeded')
  assert.deepEqual(h.calls.map((c) => [c.stepId, c.capabilities]), [['implement', ['code-write']], ['investigate', ['research', 'web-search', 'tier.standard']]])
  // The verifier got the exact Artifact the Worker produced, resolved from the slot.
  assert.equal(h.verdicts[0], `checks.checks:${se.state.steps.implement!.outputs.change}`)
  assert.equal(h.verdicts[1], `citations:${research.state.steps.investigate!.outputs.sources}`)
})

test('a Worker gets exact Artifact IDs for its inputs, never a slot name', async () => {
  const h = harness()
  const done = await runFixture(h, 'software-engineering.yaml')
  assert.deepEqual(h.calls[0]!.inputs, { task: done.state.input })
  const dispatched = done.events.find((e) => e.type === 'dispatched' && e.stepId === 'checks.checks')
  assert.deepEqual(dispatched && 'inputs' in dispatched && dispatched.inputs, { subject: done.state.steps.implement!.outputs.change, criteria: done.state.criteria['checks.checks'] })
})

test('an invalid Workflow dispatches zero Workers and creates no Work', async () => {
  const h = harness()
  const broken = fixture('software-engineering.yaml').replace('dependsOn: [implement]', 'dependsOn: [ghost]')
  assert.throws(() => resolve(parseWorkflow(broken), h.capabilities.available(), fixture), WorkflowError)
  assert.equal(h.calls.length, 0)
  assert.equal(h.table.rows.size, 0)
})

test('admission refuses a missing input and an input that is not stored', async () => {
  const h = harness()
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available(), fixture)
  await assert.rejects(() => h.controller.admit({ spec, caller, source: { kind: 'workflow-file' } }), WorkError)
  await assert.rejects(() => h.controller.admit({ spec, input: id('never stored'), caller, source: { kind: 'workflow-file' } }), /not a stored Artifact/)
  assert.equal(h.table.rows.size, 0)
})

test('a restart mid-attempt re-dispatches that step only, as a new attempt, with the same inputs', async () => {
  const table = memoryWorkTable()
  const specs = memorySpecs()
  // The first host's Worker never returns: its process "dies" mid-attempt.
  const first = harness({ table, specs, worker: { run: () => new Promise(() => {}) } })
  const spec = resolve(parseWorkflow(fixture('software-engineering.yaml')), first.capabilities.available(), fixture)
  const admitted = await first.controller.admit({ spec, input: await input(first), caller, source: { kind: 'workflow-file' } })
  void first.controller.run(admitted.id)
  while (table.rows.get(admitted.id)!.events.length < 2) await new Promise((resolve) => setImmediate(resolve))
  const lostAttempt = table.rows.get(admitted.id)!.state.steps.implement!.attempts[0]!

  const second = harness({ table, specs })
  const done = await second.controller.run(admitted.id)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(done.events.map((e) => e.type), ['admitted', 'dispatched', 'attempt-lost', 'dispatched', 'observed', 'dispatched', 'verified', 'effect-intended', 'effect-observed', 'terminal'])
  assert.equal(second.calls.length, 1, 'the second host ran implement once; checks ran once')
  assert.notEqual(second.calls[0]!.attemptId, lostAttempt)
  assert.deepEqual(done.state.steps.implement!.attempts, [lostAttempt, second.calls[0]!.attemptId])
  const [d1, d2] = done.events.filter((e) => e.type === 'dispatched' && e.stepId === 'implement')
  assert.deepEqual(d1 && 'inputs' in d1 && d1.inputs, d2 && 'inputs' in d2 && d2.inputs)

  // A terminal Work run again changes nothing and calls nothing.
  const again = await harness({ table, specs }).controller.run(admitted.id)
  assert.equal(again.events.length, done.events.length)
})

test('the stored state always equals a replay of the recorded events', async () => {
  const h = harness()
  const done = await runFixture(h, 'research.yaml')
  // Storage may hand back keys in another order (DSH revalidates records at open).
  const stored = h.table.rows.get(done.id)!
  h.table.rows.set(done.id, { ...stored, state: Object.fromEntries(Object.entries(stored.state).reverse()) as typeof stored.state })
  const replayed = h.controller.replay(done.id)
  assert.equal(replayed.matches, true)
  assert.deepEqual(fold(['investigate', 'citations', 'accept'], done.events), done.state)
  assert.equal(h.calls.length, 1, 'replay ran no Worker')
})

test('a failed, errored or missing verdict fails the Work; inconclusive is held', async () => {
  assert.equal((await runFixture(harness({ verdict: 'fail' }), 'software-engineering.yaml')).state.status, 'failed')
  assert.equal((await runFixture(harness({ verdict: 'error' }), 'software-engineering.yaml')).state.status, 'failed')
  const held = await runFixture(harness({ verdict: 'inconclusive' }), 'research.yaml')
  assert.equal(held.state.status, 'held')
  assert.match(held.state.reason!, /operator decision/)
})

test('without an accept step a failed verdict still fails the Work', async () => {
  const h = harness({ verdict: 'fail' })
  const spec = resolve(parseWorkflow(fixture('software-engineering.yaml').replace(/  - id: publish[\s\S]*$/, '')), h.capabilities.available(), fixture)
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file' } })
  const done = await h.controller.run(admitted.id)
  assert.equal(done.state.status, 'failed')
  assert.match(done.state.reason!, /checks\.checks=fail/)
})

const GATED = `schema: system.workflow/v1
id: gated
version: 1
steps:
  - id: tests
    capabilities: [code-write]
    inputs: { task: $work.input }
    outputs: [change]
  - id: red
    dependsOn: [tests]
    verify: { capability: code.required-checks, subject: $steps.tests.change, criteria: red-v1 }
  - id: implement
    dependsOn: [red]
    capabilities: [code-write]
    inputs: { task: $work.input }
    outputs: [change]
  - id: checks
    dependsOn: [implement]
    verify: { capability: code.required-checks, subject: $steps.implement.change, criteria: repo-checks-v1 }
  - id: accept
    dependsOn: [checks]
    accept: { requires: [checks] }
`

async function runGated(verdicts: VerifyResult['verdict'][]) {
  const specs = memorySpecs()
  const h = harness({ specs, verifier: scripted(specs, verdicts) })
  const spec = resolve(parseWorkflow(GATED), h.capabilities.available())
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file', path: 'gated.yaml' } })
  return { h, done: await h.controller.run(admitted.id) }
}

test('a step never starts after a failed or errored verdict it follows: the Work fails there, naming the verdict', async () => {
  for (const verdict of ['fail', 'error'] as const) {
    const { h, done } = await runGated([verdict, 'pass'])
    assert.equal(done.state.status, 'failed', verdict)
    assert.match(done.state.reason!, new RegExp(`red=${verdict}`))
    assert.equal(h.calls.length, 1, `implement never ran after a ${verdict} verdict`)
    assert.equal(h.controller.replay(done.id).matches, true)
  }
  // Inconclusive is the operator's to decide at the end, as before: the steps after it run.
  const { h, done } = await runGated(['inconclusive', 'pass'])
  assert.equal(h.calls.length, 2)
  assert.equal(done.state.status, 'succeeded')
})

test('accept with operator approval holds the Work after verification passes', async () => {
  const h = harness()
  const spec = resolve(parseWorkflow(`${fixture('software-engineering.yaml')}      approval: operator\n`), h.capabilities.available(), fixture)
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file' } })
  const done = await h.controller.run(admitted.id)
  assert.equal(done.state.status, 'held')
  assert.match(done.state.reason!, /awaiting operator approval/)
})

test("a Worker's claim of success without stored outputs fails the step", async () => {
  const h = harness({ worker: { run: async () => ({ status: 'succeeded', outputs: { change: id('never stored') } }) } })
  const done = await runFixture(h, 'software-engineering.yaml')
  assert.equal(done.state.status, 'failed')
  const observed = done.events.find((e) => e.type === 'observed')
  assert.match(observed && 'reason' in observed ? observed.reason! : '', /without stored outputs change/)
})

test('a Worker that throws or reports failure fails the Work with the reason', async () => {
  const threw = await runFixture(harness({ worker: { run: async () => { throw new Error('boom') } } }), 'research.yaml')
  assert.equal(threw.state.status, 'failed')
  const reported = await runFixture(harness({ worker: { run: async () => ({ status: 'failed', outputs: {}, reason: 'tests red' }) } }), 'research.yaml')
  assert.equal(reported.state.status, 'failed')
  assert.match(reported.state.reason!, /step investigate failed/)
})

test('a Worker that disappears after admission fails the Work with a missing-capability reason', async () => {
  const h = harness()
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available(), fixture)
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file' } })
  const bare = new WorkController(h.table, h.specs, new Capabilities())
  const done = await bare.run(admitted.id)
  assert.equal(done.state.status, 'failed')
  assert.match(done.state.reason!, /no enabled Worker provides research, web-search, tier.standard/)
})

test('usage a Worker does not report is recorded as unknown, never zero', async () => {
  const done = await runFixture(harness(), 'research.yaml')
  const observed = done.events.find((e) => e.type === 'observed')
  assert.deepEqual(observed && 'usage' in observed && observed.usage, { state: 'unknown' })
})

test('routing records every candidate and why it was or was not chosen', async () => {
  const h = harness()
  h.capabilities.registerWorker({ ref: 'coder-only', capabilities: ['code-write'], run: async () => ({ status: 'failed', outputs: {} }) })
  const done = await runFixture(h, 'research.yaml')
  const dispatched = done.events.find((e) => e.type === 'dispatched')
  assert.deepEqual(dispatched && 'candidates' in dispatched && dispatched.candidates, [
    { ref: 'fake', selected: true, reason: 'provides research, web-search, tier.standard' },
    { ref: 'coder-only', selected: false, reason: 'lacks research, web-search, tier.standard' },
  ])
})

test('cancel with no live host records the outcome directly, with the caller', async () => {
  const h = harness()
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available(), fixture)
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file' } })
  const done = await h.controller.cancel(admitted.id, { reason: 'not needed', caller: { type: 'agent', operatorId: 'tan' } })
  assert.notEqual(done, 'requested')
  if (done === 'requested') return
  assert.equal(done.state.status, 'cancelled')
  assert.match(done.state.reason!, /cancelled by agent tan: not needed/)
  assert.equal(h.calls.length, 0)
  await assert.rejects(() => h.controller.cancel(admitted.id, { reason: 'again', caller }), /already cancelled/)
})

test('retry is refused for running or succeeded Work and for an unknown Worker', async () => {
  const h = harness()
  const done = await runFixture(h, 'research.yaml')
  await assert.rejects(() => h.controller.retry(done.id, { caller, reason: 'x' }), /only failed, cancelled or held Work is retried/)
  const failed = await runFixture(harness({ worker: { run: async () => ({ status: 'failed', outputs: {}, reason: 'red' }) } }), 'research.yaml')
  const fresh = harness({ table: memoryWorkTable(new Map([[failed.id, failed]])) })
  await assert.rejects(() => fresh.controller.retry(failed.id, { worker: 'nobody', caller, reason: 'x' }), /no enabled Worker nobody/)
})

test('a Work submitted for one Worker runs its Worker steps only there, and is refused for one that cannot', async () => {
  const h = harness()
  const ran: string[] = []
  const register = (ref: string, capabilities: string[]) => h.capabilities.registerWorker({
    ref, capabilities,
    async run(request) {
      ran.push(ref)
      const out = id(`${ref}/${request.attemptId}`)
      h.specs.stored.add(out)
      return { status: 'succeeded', outputs: Object.fromEntries(request.outputs.map((slot) => [slot, out])) }
    },
  })
  register('first', ['research', 'web-search', 'tier.standard'])
  register('plain', ['code-write'])
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available(), fixture)
  const base = { spec, input: await input(h), caller, source: { kind: 'workflow-file' as const } }
  await assert.rejects(() => h.controller.admit({ ...base, worker: 'nobody' }), /no enabled Worker nobody/)
  await assert.rejects(() => h.controller.admit({ ...base, worker: 'plain' }), /plain does not provide research, web-search, tier.standard for step investigate/)
  const admitted = await h.controller.admit({ ...base, worker: 'first' })
  assert.equal(admitted.events[0]!.type === 'admitted' && admitted.events[0]!.worker, 'first')
  const done = await h.controller.run(admitted.id)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(ran, ['first'], 'the Worker "fake", registered first, did not take the step')
  assert.equal(h.controller.replay(admitted.id).matches, true)
  // Without the pin the first registered Worker that fits takes the step.
  const free = await h.controller.run((await h.controller.admit(base)).id)
  assert.equal(free.events.find((e) => e.type === 'dispatched')?.type === 'dispatched' && free.events.find((e) => e.type === 'dispatched')!.selected, 'fake')
})

test('a cancel during an attempt keeps its partial output, and retry hands it on as previous', async () => {
  const h = harness({
    worker: {
      async run(request) {
        if (request.inputs.previous) {
          const out = id(`${request.attemptId}/done`)
          h.specs.stored.add(out)
          return { status: 'succeeded', outputs: Object.fromEntries(request.outputs.map((s) => [s, out])) }
        }
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }))
        const partial = id('partial')
        h.specs.stored.add(partial)
        return { status: 'cancelled', outputs: {}, partial: { report: partial } }
      },
    },
  })
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available(), fixture)
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file' } })
  const running = h.controller.run(admitted.id)
  while (h.table.rows.get(admitted.id)!.events.length < 2) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await h.controller.cancel(admitted.id, { reason: 'stop', caller }), 'requested')
  const cancelled = await running
  assert.equal(cancelled.state.status, 'cancelled')
  assert.deepEqual(cancelled.state.steps.investigate!.partial, { report: id('partial') })
  const done = await h.controller.retry(admitted.id, { caller, reason: 'again' })
  assert.equal(done.state.status, 'succeeded')
  const second = done.events.filter((e) => e.type === 'dispatched')[1]
  assert.equal(second?.type === 'dispatched' && second.inputs.previous, id('partial'))
  assert.equal(h.controller.replay(admitted.id).matches, true)
})

test('a succeeded attempt keeps the Artifacts it reports beside its outputs, and replay matches', async () => {
  const h = harness({
    worker: {
      async run(request) {
        const out = id(`${request.attemptId}/done`)
        const extra = id(`${request.attemptId}/evidence`)
        h.specs.stored.add(out)
        h.specs.stored.add(extra)
        return { status: 'succeeded', outputs: Object.fromEntries(request.outputs.map((s) => [s, out])), partial: { evidence: extra } }
      },
    },
  })
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available(), fixture)
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file' } })
  const done = await h.controller.run(admitted.id)
  assert.equal(done.state.status, 'succeeded')
  const step = done.state.steps.investigate!
  assert.equal(step.state, 'succeeded')
  assert.deepEqual(Object.keys(step.partial ?? {}), ['evidence'])
  const observed = done.events.find((e) => e.type === 'observed')
  assert.ok(observed?.type === 'observed' && observed.partial?.evidence, 'the observation records it')
  assert.equal(h.controller.replay(admitted.id).matches, true)
})

test('a tier is a capability: a step asking for a tier no Worker offers is refused at preflight', () => {
  const capabilities = new Capabilities()
  capabilities.registerWorker({ ref: 'claude', capabilities: ['code-write', 'tier.standard', 'tier.frontier'], run: async () => ({ status: 'failed', outputs: {} }) })
  const workflow = (tier: string) => `schema: system.workflow/v1\nid: t\nversion: 1\nsteps:\n  - id: a\n    capabilities: [code-write, ${tier}]\n    outputs: [x]\n`
  assert.doesNotThrow(() => resolve(parseWorkflow(workflow('tier.frontier')), capabilities.available(), fixture))
  assert.throws(() => resolve(parseWorkflow(workflow('tier.economy')), capabilities.available(), fixture), /needs Worker capability tier.economy, which no enabled Worker provides/)
  assert.equal(capabilities.routeWorker(['code-write', 'tier.frontier']).selected?.ref, 'claude')
})

async function verdictOf(h: Harness, verifier: Partial<VerifierPort>) {
  const custom = harness({ ...{ table: h.table, specs: h.specs }, verifier })
  const done = await runFixture(custom, 'software-engineering.yaml')
  const verified = done.events.find((e) => e.type === 'verified')
  return { done, verified: verified?.type === 'verified' ? verified : undefined, specs: custom.specs }
}

test('a verdict about another subject, other criteria, or without stored evidence is an error, never a pass', async () => {
  const cases: [string, Partial<VerifierPort>, RegExp][] = [
    ['wrong subject', { async verify(r) { return { verdict: 'pass', reason: 'ok', subject: id('another tree'), criteria: r.criteria, evidence: [r.subject] } } }, /it judged .* not the subject/],
    ['other criteria', { async verify(r) { return { verdict: 'pass', reason: 'ok', subject: r.subject, criteria: id('laxer criteria'), evidence: [r.subject] } } }, /not the pinned/],
    ['no evidence', { async verify(r) { return { verdict: 'pass', reason: 'ok', subject: r.subject, criteria: r.criteria, evidence: [] } } }, /a pass needs evidence/],
    ['unstored evidence', { async verify(r) { return { verdict: 'pass', reason: 'ok', subject: r.subject, criteria: r.criteria, evidence: [id('nowhere')] } } }, /is not stored/],
    ['subject kind not accepted', { accepts: ['git-tree'] }, /judges git-tree, not output/],
  ]
  for (const [name, verifier, reason] of cases) {
    const { done, verified } = await verdictOf(harness(), verifier)
    assert.equal(verified?.verdict, 'error', name)
    assert.match(verified!.reason, reason, name)
    assert.equal(done.state.status, 'failed', name)
  }
})

test('the controller stores the verdict Artifact bound to the exact subject and pinned criteria', async () => {
  const h = harness()
  const done = await runFixture(h, 'software-engineering.yaml')
  const verified = done.events.find((e) => e.type === 'verified')
  assert.ok(verified?.type === 'verified' && verified.verdictId)
  const stored = h.specs.verdicts.get(verified.verdictId!)!
  assert.deepEqual([stored.subject, stored.criteria, stored.verdict, stored.verifier], [done.state.steps.implement!.outputs.change, done.state.criteria['checks.checks'], 'pass', { ref: 'fake-verifier', version: '1' }])
  assert.equal(stored.evidence.length, 1)
})

test('criteria a verifier cannot pin refuse admission, and no Work is created', async () => {
  const h = harness({ verifier: { async criteria() { throw new Error('no .system/checks.yaml at the base commit') } } })
  const spec = resolve(parseWorkflow(fixture('software-engineering.yaml')), h.capabilities.available(), fixture)
  const task = await input(h)
  await assert.rejects(() => h.controller.admit({ spec, input: task, caller, source: { kind: 'workflow-file' } }), /cannot pin criteria repo-checks-v1: no .system\/checks.yaml/)
  assert.equal(h.table.rows.size, 0)
})

test('retry --step after failed checks reruns the Worker and re-verifies the new subject; the old verdict never counts', async () => {
  let verdict: VerifyResult['verdict'] = 'fail'
  const specs = memorySpecs()
  const h = harness({ specs, verifier: { async verify(r) {
    const evidence = id(`evidence/${r.attemptId}`)
    specs.stored.add(evidence)
    return { verdict, reason: verdict, subject: r.subject, criteria: r.criteria, evidence: [evidence] }
  } } })
  const failed = await runFixture(h, 'software-engineering.yaml')
  assert.equal(failed.state.status, 'failed')
  // The Workflow's one automatic further attempt failed too: the operator's retry is a third.
  assert.equal(failed.events.filter((e) => e.type === 'reopened' && e.automatic).length, 1)
  const secondChange = failed.state.steps.implement!.outputs.change
  await assert.rejects(() => h.controller.retry(failed.id, { caller, reason: 'x' }), /name one with --step/)
  verdict = 'pass'
  const done = await h.controller.retry(failed.id, { step: 'implement', caller, reason: 'fix the failing checks' })
  assert.equal(done.state.status, 'succeeded')
  const reopened = done.events.findLast((e) => e.type === 'reopened')
  assert.deepEqual(reopened?.type === 'reopened' && reopened.reset, ['implement', 'checks.checks', 'publish', 'accept'])
  assert.deepEqual(reopened?.type === 'reopened' && reopened.caller, caller)
  const verifiedSubjects = done.events.filter((e) => e.type === 'verified').map((e) => e.type === 'verified' && e.subject)
  assert.equal(verifiedSubjects.length, 3)
  assert.equal(verifiedSubjects[1], secondChange)
  assert.equal(verifiedSubjects[2], done.state.steps.implement!.outputs.change)
  assert.notEqual(verifiedSubjects[2], secondChange)
  assert.equal(h.controller.replay(failed.id).matches, true)
})

test('the controller and Workflow compiler name no domain, Worker or verifier', () => {
  const src = join(repo, 'packages', 'work', 'src')
  for (const file of ['controller.ts', 'workflow.ts', 'record.ts', 'registry.ts']) {
    const code = readFileSync(join(src, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    assert.doesNotMatch(code, /research|software|engineering|citation|claude|codex|required-checks|code-write|git-tree/i, file)
  }
})

test('a Work record written before M4 (no criteria, no new event fields) still parses and replays', async () => {
  const { workRecordSchema } = await import('../src/record.ts')
  const spec = 'sha256:' + 'a'.repeat(64)
  const input = 'sha256:' + 'b'.repeat(64)
  const out = 'sha256:' + 'c'.repeat(64)
  const old = {
    id: 'work:old',
    events: [
      { type: 'admitted', seq: 0, at: 't', caller: { type: 'agent', operatorId: 'tan' }, specId: spec, input, source: { kind: 'direct-task' } },
      { type: 'dispatched', seq: 1, at: 't', stepId: 'task', attemptId: 'attempt:1', executor: 'worker', capability: 'code-write', selected: 'claude-code/default', candidates: [], inputs: { input } },
      { type: 'observed', seq: 2, at: 't', stepId: 'task', attemptId: 'attempt:1', status: 'succeeded', outputs: { result: out }, usage: { state: 'unknown' }, worker: { ref: 'claude-code/default', account: 'default', command: '/x/claude', version: '2.1.311' } },
      { type: 'terminal', seq: 3, at: 't', outcome: 'succeeded', reason: 'every step succeeded', results: { 'task.result': out } },
    ],
    state: { status: 'succeeded', specId: spec, input, steps: { task: { state: 'succeeded', attempts: ['attempt:1'], outputs: { result: out } } }, reason: 'every step succeeded', results: { 'task.result': out } },
  }
  const parsed = workRecordSchema.parse(old)
  assert.deepEqual(parsed.state.criteria, {})
  assert.deepEqual(fold(['task'], parsed.events), parsed.state)
})

test('a record whose admitted event has a Goal and an orchestrator caller (written before the Goal feature was removed) still opens and replays', async () => {
  const { workRecordSchema } = await import('../src/record.ts')
  const spec = 'sha256:' + 'a'.repeat(64)
  const input = 'sha256:' + 'b'.repeat(64)
  const goal = 'sha256:' + 'd'.repeat(64)
  const out = 'sha256:' + 'c'.repeat(64)
  const old = {
    id: 'work:goal',
    events: [
      { type: 'admitted', seq: 0, at: 't', caller: { type: 'orchestrator', operatorId: 'tan', goal }, specId: spec, input, goal, source: { kind: 'direct-task' } },
      { type: 'dispatched', seq: 1, at: 't', stepId: 'task', attemptId: 'attempt:1', executor: 'worker', capability: 'code-write', selected: 'claude-code/default', candidates: [], inputs: { input } },
      { type: 'observed', seq: 2, at: 't', stepId: 'task', attemptId: 'attempt:1', status: 'succeeded', outputs: { result: out }, usage: { state: 'unknown' } },
      { type: 'terminal', seq: 3, at: 't', outcome: 'succeeded', reason: 'every step succeeded', results: { 'task.result': out } },
    ],
    state: { status: 'succeeded', specId: spec, input, steps: { task: { state: 'succeeded', attempts: ['attempt:1'], outputs: { result: out } } }, reason: 'every step succeeded', results: { 'task.result': out } },
  }
  const parsed = workRecordSchema.parse(old)
  assert.deepEqual(fold(['task'], parsed.events), parsed.state)
})

test('a host lost during admission, after the spec was pinned and before the Work record, leaves no Work and runs nothing', async () => {
  const h = harness()
  h.table.put = async () => { throw new Error('host lost') }
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available(), fixture)
  const task = await input(h)
  await assert.rejects(() => h.controller.admit({ spec, input: task, caller, source: { kind: 'workflow-file' } }), /host lost/)
  assert.equal(h.table.rows.size, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(h.controller.list().length, 0)
})

test('the verifier is pinned at admission with its version: another version at run time is an error verdict', async () => {
  const table = memoryWorkTable()
  const specs = memorySpecs()
  const v1 = harness({ table, specs })
  const spec = resolve(parseWorkflow(fixture('research.yaml')), v1.capabilities.available(), fixture)
  const admitted = await v1.controller.admit({ spec, input: await input(v1), caller, source: { kind: 'workflow-file' } })
  const admittedEvent = admitted.events[0]
  assert.deepEqual(admittedEvent?.type === 'admitted' && admittedEvent.verifiers, { citations: { ref: 'fake-verifier', version: '1' } })
  const v2 = harness({ table, specs, verifier: { version: '2' } })
  const done = await v2.controller.run(admitted.id)
  const verified = done.events.find((e) => e.type === 'verified')
  assert.equal(verified?.type === 'verified' && verified.verdict, 'error')
  assert.match(verified?.type === 'verified' ? verified.reason : '', /pinned fake-verifier@1 at admission; fake-verifier@2 is enabled now/)
  assert.equal(done.state.status, 'failed')
})

test('an attempt that failed on a rate limit is recorded as rate-limited; another failure is not', async () => {
  for (const [reason, rateLimited] of [['fake: 429 Too Many Requests', true], ['claude usage limit reached; rate limit resets at 5pm', true], ['tests red', false]] as const) {
    const done = await runFixture(harness({ worker: { run: async () => ({ status: 'failed', outputs: {}, reason }) } }), 'research.yaml')
    const observed = done.events.find((e) => e.type === 'observed')
    assert.ok(observed?.type === 'observed')
    assert.equal(observed.rateLimited, rateLimited ? true : undefined, reason)
  }
})

const RETRY = `schema: system.workflow/v1
id: retrying
version: 1
steps:
  - id: implement
    capabilities: [code-write]
    inputs: { task: $work.input }
    outputs: [change]
    retry: { onFail: [checks, implement], max: 1 }
  - id: checks
    dependsOn: [implement]
    verify: { capability: code.required-checks, subject: $steps.implement.change, criteria: repo-checks-v1 }
  - id: accept
    dependsOn: [checks]
    accept: { requires: [checks] }
`

async function runRetrying(h: Harness) {
  return runWith(RETRY, h)
}

async function runWith(yaml: string, h: Harness) {
  const spec = resolve(parseWorkflow(yaml), h.capabilities.available())
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file', path: 'retrying.yaml' } })
  return h.controller.run(admitted.id)
}

const RETRY_TWO = `schema: system.workflow/v1
id: retry-two
version: 1
steps:
  - id: tests
    capabilities: [code-write]
    inputs: { task: $work.input }
    outputs: [change]
    retry: { onFail: [red, checks], max: 1 }
  - id: red
    dependsOn: [tests]
    verify: { capability: code.required-checks, subject: $steps.tests.change, criteria: red-v1 }
  - id: implement
    dependsOn: [red]
    capabilities: [code-write]
    inputs: { task: $work.input }
    outputs: [change]
    retry: { onFail: [frozen, checks], max: 1 }
  - id: frozen
    dependsOn: [implement]
    verify: { capability: code.required-checks, subject: $steps.implement.change, criteria: frozen-v1 }
  - id: checks
    dependsOn: [frozen]
    verify: { capability: code.required-checks, subject: $steps.implement.change, criteria: repo-checks-v1 }
  - id: accept
    dependsOn: [checks]
    accept: { requires: [checks] }
`

/** A verifier whose verdicts are taken from `verdicts` in turn (the last one repeats). */
function scripted(specs: ReturnType<typeof memorySpecs>, verdicts: VerifyResult['verdict'][]): Partial<VerifierPort> {
  let n = 0
  return { async verify(r) {
    const evidence = id(`evidence/${r.attemptId}`)
    specs.stored.add(evidence)
    return { verdict: verdicts[Math.min(n++, verdicts.length - 1)]!, reason: 'scripted', subject: r.subject, criteria: r.criteria, evidence: [evidence] }
  } }
}

function byStep(specs: ReturnType<typeof memorySpecs>, verdicts: Record<string, VerifyResult['verdict'][]>): Partial<VerifierPort> {
  const calls = new Map<string, number>()
  return { async verify(r) {
    const n = calls.get(r.stepId) ?? 0
    calls.set(r.stepId, n + 1)
    const sequence = verdicts[r.stepId] ?? ['pass']
    const evidence = id(`evidence/${r.attemptId}`)
    specs.stored.add(evidence)
    return { verdict: sequence[Math.min(n, sequence.length - 1)]!, reason: 'scripted', subject: r.subject, criteria: r.criteria, evidence: [evidence] }
  } }
}

function autoReopens(w: WorkRecord) {
  return w.events.flatMap((e) => (e.type === 'reopened' && e.automatic ? [e] : []))
}

test('budget is per verify step: frozen then checks each reopen implement once', async () => {
  const specs = memorySpecs()
  const h = harness({ specs, verifier: byStep(specs, { red: ['pass'], frozen: ['fail', 'pass'], checks: ['fail', 'pass'] }) })
  const done = await runWith(RETRY_TWO, h)
  assert.equal(done.state.status, 'succeeded')
  const reopened = autoReopens(done)
  assert.deepEqual(reopened.map((e) => e.stepId), ['implement', 'implement'])
  const failedVerdicts = done.events.flatMap((e) => (e.type === 'verified' && e.verdict === 'fail' ? [e.verdictId] : []))
  assert.deepEqual(reopened.map((e) => e.failure), failedVerdicts)
})

test('a failing checks verdict reopens the nearest step that has budget: tests when implement is spent', async () => {
  const specs = memorySpecs()
  const h = harness({ specs, verifier: byStep(specs, { red: ['pass'], frozen: ['fail', 'pass'], checks: ['fail', 'fail', 'pass'] }) })
  const done = await runWith(RETRY_TWO, h)
  assert.equal(done.state.status, 'succeeded')
  const reopened = autoReopens(done)
  assert.deepEqual(reopened.map((e) => e.stepId), ['implement', 'implement', 'tests'])
  const last = reopened[2]!
  assert.deepEqual(last.reset, ['tests', 'red', 'implement', 'frozen', 'checks', 'accept'])
  const priorTests = done.events.find((e) => e.type === 'observed' && e.stepId === 'tests')
  assert.ok(priorTests?.type === 'observed')
  const firstTestsCall = h.calls.find((c) => c.stepId === 'tests')!
  const testsCalls = h.calls.filter((c) => c.stepId === 'tests')
  assert.equal(testsCalls.length, 2)
  assert.equal(firstTestsCall.inputs.failure, undefined)
  assert.equal(testsCalls[1]!.inputs.failure, last.failure)
  assert.equal(testsCalls[1]!.inputs.previous, priorTests.outputs.change)
  assert.equal(h.controller.replay(done.id).matches, true)
})

test('the nearest step is reopened first: with budget on both, implement and not tests', async () => {
  const specs = memorySpecs()
  const h = harness({ specs, verifier: byStep(specs, { red: ['pass'], frozen: ['pass'], checks: ['fail', 'pass'] }) })
  const done = await runWith(RETRY_TWO, h)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(autoReopens(done).map((e) => e.stepId), ['implement'])
  assert.equal(h.calls.filter((c) => c.stepId === 'tests').length, 1)
})

test('when no candidate has budget left, the Work does not succeed', async () => {
  const specs = memorySpecs()
  const h = harness({ specs, verifier: byStep(specs, { red: ['pass'], frozen: ['pass'], checks: ['fail'] }) })
  const done = await runWith(RETRY_TWO, h)
  assert.notEqual(done.state.status, 'succeeded')
  assert.deepEqual(autoReopens(done).map((e) => e.stepId), ['implement', 'tests'])
})

test('a failing verdict named in retry.onFail reopens the step once, automatically, with the verdict and the change as input', async () => {
  const specs = memorySpecs()
  const requests: Array<{ stepId: string; earlier?: string[] }> = []
  const scriptedVerifier = scripted(specs, ['fail', 'pass'])
  const h = harness({ specs, verifier: {
    ...scriptedVerifier,
    async verify(request) {
      requests.push({ stepId: request.stepId, ...('earlier' in request && Array.isArray(request.earlier) ? { earlier: request.earlier } : {}) })
      return scriptedVerifier.verify!(request)
    },
  } })
  const done = await runRetrying(h)
  assert.equal(done.state.status, 'succeeded')
  assert.equal(h.calls.length, 2)
  const reopened = done.events.filter((e) => e.type === 'reopened')
  assert.equal(reopened.length, 1)
  assert.ok(reopened[0]?.type === 'reopened')
  assert.equal(reopened[0].automatic, true)
  assert.equal(reopened[0].caller, undefined)
  const failing = done.events.find((e) => e.type === 'verified')
  assert.ok(failing?.type === 'verified')
  assert.equal(requests[0]!.earlier, undefined)
  assert.deepEqual(requests[1]!.earlier, failing.evidence)
  assert.equal(h.calls[1]!.inputs.failure, failing.verdictId)
  const first = done.events.find((e) => e.type === 'observed')
  assert.ok(first?.type === 'observed')
  assert.equal(h.calls[1]!.inputs.previous, first.outputs.change)
  assert.equal(h.controller.replay(done.id).matches, true)
})

test('the automatic further attempt is made once: a second failure fails the Work', async () => {
  const specs = memorySpecs()
  const h = harness({ specs, verifier: scripted(specs, ['fail']) })
  const done = await runRetrying(h)
  assert.equal(done.state.status, 'failed')
  assert.equal(h.calls.length, 2)
  assert.equal(done.events.filter((e) => e.type === 'reopened').length, 1)
})

test('only a failing verdict qualifies: an error or inconclusive verdict is not tried again', async () => {
  for (const verdict of ['error', 'inconclusive'] as const) {
    const specs = memorySpecs()
    const h = harness({ specs, verifier: scripted(specs, [verdict]) })
    await runRetrying(h)
    assert.equal(h.calls.length, 1, verdict)
  }
})

test('an inconclusive verdict named in retry.onFail does not reopen: the Work is held, and approve finishes it (df-25)', async () => {
  const specs = memorySpecs()
  const h = harness({ specs, verifier: scripted(specs, ['inconclusive']) })
  const spec = resolve(parseWorkflow(RETRY.replace(/    retry:.*\n/, '    retry: { onFail: [checks], max: 1 }\n')), h.capabilities.available())
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file', path: 'retrying.yaml' } })
  const held = await h.controller.run(admitted.id)
  assert.equal(h.calls.length, 1)
  assert.equal(held.events.filter((e) => e.type === 'reopened').length, 0)
  assert.equal(held.state.status, 'held')
  assert.equal(held.state.awaiting, 'accept')
  const done = await h.controller.decide(held.id, { decision: 'approved', caller, reason: 'the base fails it too' })
  assert.equal(done.state.status, 'succeeded')
  assert.equal(h.calls.length, 1)
})

test('a Worker failure is tried afresh only when the Worker says so, and with no previous output or failure input', async () => {
  for (const retryable of [true, false]) {
    let n = 0
    const h = harness({ worker: { async run(r) {
      if (n++ === 0) return { status: 'failed', outputs: {}, reason: 'no output block', ...(retryable ? { retryable: true as const } : {}) }
      const outputs = Object.fromEntries(r.outputs.map((slot) => [slot, id(`${r.attemptId}/${slot}`)]))
      for (const out of Object.values(outputs)) h.specs.stored.add(out)
      return { status: 'succeeded', outputs }
    } } })
    const done = await runRetrying(h)
    assert.equal(done.state.status, retryable ? 'succeeded' : 'failed', String(retryable))
    assert.equal(n, retryable ? 2 : 1)
    if (retryable) assert.deepEqual(Object.keys(done.events.filter((e) => e.type === 'dispatched')[1]!.inputs), ['task'])
    const observed = done.events.find((e) => e.type === 'observed')
    assert.ok(observed?.type === 'observed')
    assert.equal(observed.retryable, retryable ? true : undefined)
  }
})

test('a step with no retry declared is never tried again by itself', async () => {
  const specs = memorySpecs()
  const h = harness({ specs, verifier: scripted(specs, ['fail']) })
  const spec = resolve(parseWorkflow(RETRY.replace(/    retry:.*\n/, '')), h.capabilities.available())
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file', path: 'x.yaml' } })
  await h.controller.run(admitted.id)
  assert.equal(h.calls.length, 1)
})

test('a later step whose message objects to an earlier output reopens that step once, with the objection as its failure input (dg-8)', async () => {
  const yaml = RETRY_TWO.replace('onFail: [red, checks]', 'onFail: [red, checks, implement]')
  let n = 0
  const h: Harness = harness({ worker: { async run(r) {
    h.calls.push(r)
    const outputs = Object.fromEntries(r.outputs.map((slot) => [slot, id(`${r.attemptId}/${slot}`)]))
    for (const out of Object.values(outputs)) h.specs.stored.add(out)
    const objects = r.stepId === 'implement' && n++ === 0
    return { status: 'succeeded', outputs, ...(objects ? { message: 'Nothing done.\nOBJECTION: test a.test.ts asserts 2, the rule says 3' } : {}) }
  } } })
  const done = await runWith(yaml, h)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(h.calls.map((c) => c.stepId), ['tests', 'implement', 'tests', 'implement'])
  const observed = done.events.find((e) => e.type === 'observed' && e.stepId === 'implement')
  assert.ok(observed?.type === 'observed')
  assert.equal(observed.status, 'failed')
  assert.match(observed.objection ?? '', /^test a\.test\.ts asserts 2/)
  const reopened = done.events.filter((e) => e.type === 'reopened')
  assert.equal(reopened.length, 1)
  assert.ok(reopened[0]?.type === 'reopened')
  assert.equal(reopened[0].stepId, 'tests')
  assert.equal(reopened[0].objectedBy, 'implement')
  assert.ok(h.calls[2]!.inputs.failure)
  assert.equal(h.controller.replay(done.id).matches, true)
})

test('an objection past the retry budget fails the Work; a step no one lists in onFail cannot object', async () => {
  const worker = (h: () => Harness): Partial<WorkerPort> => ({ async run(r) {
    const outputs = Object.fromEntries(r.outputs.map((slot) => [slot, id(`${r.attemptId}/${slot}`)]))
    for (const out of Object.values(outputs)) h().specs.stored.add(out)
    return { status: 'succeeded', outputs, message: 'OBJECTION: wrong' }
  } })
  const listed: Harness = harness({ worker: worker(() => listed) })
  const done = await runWith(RETRY_TWO.replace('onFail: [red, checks]', 'onFail: [red, checks, implement]'), listed)
  assert.equal(done.state.status, 'failed')
  assert.equal(done.events.filter((e) => e.type === 'reopened').length, 1)
  const unlisted: Harness = harness({ worker: worker(() => unlisted) })
  const plain = await runWith(RETRY_TWO, unlisted)
  assert.equal(plain.state.status, 'succeeded')
  assert.equal(plain.events.filter((e) => e.type === 'reopened').length, 0)
})
