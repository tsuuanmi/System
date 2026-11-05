import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WorkController, WorkError, type SpecStore, type WorkTable } from '../src/controller.ts'
import { fold, type WorkRecord } from '../src/record.ts'
import { Capabilities, type VerifyResult, type WorkerPort, type WorkerRequest } from '../src/registry.ts'
import { WorkflowError, directTask, parseWorkflow, resolve, type ResolvedSpec } from '../src/workflow.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const fixture = (name: string) => readFileSync(join(repo, 'workflows', name), 'utf8')
const caller = { type: 'human', operatorId: 'tan' } as const
const id = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

/** Like a DSH table: durable first, visible in memory a turn later. */
function memoryTable(rows = new Map<string, WorkRecord>()): WorkTable & { rows: Map<string, WorkRecord> } {
  const turn = () => new Promise((resolve) => setImmediate(resolve))
  return {
    rows,
    get: (key) => rows.get(key),
    keys: () => rows.keys(),
    async put(key, value) { await turn(); rows.set(key, structuredClone(value)) },
    async update(key, fn) {
      const next = fn(structuredClone(rows.get(key)!))
      await turn()
      rows.set(key, next)
      return structuredClone(next)
    },
  }
}

function memorySpecs(): SpecStore & { stored: Set<string> } {
  const specs = new Map<string, ResolvedSpec>()
  const stored = new Set<string>()
  return {
    stored,
    async putSpec(spec) {
      const specId = id(JSON.stringify(spec))
      specs.set(specId, structuredClone(spec))
      stored.add(specId)
      return specId
    },
    getSpec: (specId) => structuredClone(specs.get(specId)),
    exists: (artifactId) => stored.has(artifactId),
  }
}

interface Harness {
  controller: WorkController
  capabilities: Capabilities
  calls: WorkerRequest[]
  verdicts: string[]
  table: ReturnType<typeof memoryTable>
  specs: ReturnType<typeof memorySpecs>
}

function harness(options: { verdict?: VerifyResult['verdict']; worker?: Partial<WorkerPort>; table?: ReturnType<typeof memoryTable>; specs?: ReturnType<typeof memorySpecs> } = {}): Harness {
  const table = options.table ?? memoryTable()
  const specs = options.specs ?? memorySpecs()
  const capabilities = new Capabilities()
  const calls: WorkerRequest[] = []
  const verdicts: string[] = []
  capabilities.registerWorker({
    ref: 'fake',
    capabilities: ['code-write', 'research', 'web-search'],
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
    capabilities: ['code.required-checks', 'research.citation-check'],
    async verify(request) {
      verdicts.push(`${request.stepId}:${request.subject}`)
      return { verdict: options.verdict ?? 'pass', reason: 'scripted' }
    },
  })
  return { controller: new WorkController(table, specs, capabilities), capabilities, calls, verdicts, table, specs }
}

async function input(h: Harness): Promise<string> {
  const artifactId = id('the task')
  h.specs.stored.add(artifactId)
  return artifactId
}

async function runFixture(h: Harness, name: string) {
  const spec = resolve(parseWorkflow(fixture(name)), h.capabilities.available())
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file', path: name } })
  return h.controller.run(admitted.id)
}

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
  assert.deepEqual(h.calls.map((c) => [c.stepId, c.capabilities]), [['implement', ['code-write']], ['investigate', ['research', 'web-search']]])
  // The verifier got the exact Artifact the Worker produced, resolved from the slot.
  assert.equal(h.verdicts[0], `checks:${se.state.steps.implement!.outputs.change}`)
  assert.equal(h.verdicts[1], `citations:${research.state.steps.investigate!.outputs.sources}`)
})

test('a Worker gets exact Artifact IDs for its inputs, never a slot name', async () => {
  const h = harness()
  const done = await runFixture(h, 'software-engineering.yaml')
  assert.deepEqual(h.calls[0]!.inputs, { task: done.state.input })
  const dispatched = done.events.find((e) => e.type === 'dispatched' && e.stepId === 'checks')
  assert.deepEqual(dispatched && 'inputs' in dispatched && dispatched.inputs, { subject: done.state.steps.implement!.outputs.change })
})

test('an invalid Workflow dispatches zero Workers and creates no Work', async () => {
  const h = harness()
  const broken = fixture('software-engineering.yaml').replace('dependsOn: [implement]', 'dependsOn: [ghost]')
  assert.throws(() => resolve(parseWorkflow(broken), h.capabilities.available()), WorkflowError)
  assert.equal(h.calls.length, 0)
  assert.equal(h.table.rows.size, 0)
})

test('admission refuses a missing input and an input that is not stored', async () => {
  const h = harness()
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available())
  await assert.rejects(() => h.controller.admit({ spec, caller, source: { kind: 'workflow-file' } }), WorkError)
  await assert.rejects(() => h.controller.admit({ spec, input: id('never stored'), caller, source: { kind: 'workflow-file' } }), /not a stored Artifact/)
  assert.equal(h.table.rows.size, 0)
})

test('a restart mid-attempt re-dispatches that step only, as a new attempt, with the same inputs', async () => {
  const table = memoryTable()
  const specs = memorySpecs()
  // The first host's Worker never returns: its process "dies" mid-attempt.
  const first = harness({ table, specs, worker: { run: () => new Promise(() => {}) } })
  const spec = resolve(parseWorkflow(fixture('software-engineering.yaml')), first.capabilities.available())
  const admitted = await first.controller.admit({ spec, input: await input(first), caller, source: { kind: 'workflow-file' } })
  void first.controller.run(admitted.id)
  while (table.rows.get(admitted.id)!.events.length < 2) await new Promise((resolve) => setImmediate(resolve))
  const lostAttempt = table.rows.get(admitted.id)!.state.steps.implement!.attempts[0]!

  const second = harness({ table, specs })
  const done = await second.controller.run(admitted.id)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(done.events.map((e) => e.type), ['admitted', 'dispatched', 'attempt-lost', 'dispatched', 'observed', 'dispatched', 'verified', 'terminal'])
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
  const spec = resolve(parseWorkflow(fixture('software-engineering.yaml').replace(/  - id: accept[\s\S]*$/, '')), h.capabilities.available())
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file' } })
  const done = await h.controller.run(admitted.id)
  assert.equal(done.state.status, 'failed')
  assert.match(done.state.reason!, /checks=fail/)
})

test('accept with operator approval holds the Work after verification passes', async () => {
  const h = harness()
  const spec = resolve(parseWorkflow(`${fixture('software-engineering.yaml')}      approval: operator\n`), h.capabilities.available())
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
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available())
  const admitted = await h.controller.admit({ spec, input: await input(h), caller, source: { kind: 'workflow-file' } })
  const bare = new WorkController(h.table, h.specs, new Capabilities())
  const done = await bare.run(admitted.id)
  assert.equal(done.state.status, 'failed')
  assert.match(done.state.reason!, /no enabled Worker provides research, web-search/)
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
    { ref: 'fake', selected: true, reason: 'provides research, web-search' },
    { ref: 'coder-only', selected: false, reason: 'lacks research, web-search' },
  ])
})

test('cancel with no live host records the outcome directly, with the caller', async () => {
  const h = harness()
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available())
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
  await assert.rejects(() => h.controller.retry(done.id, { caller, reason: 'x' }), /only failed or cancelled Work is retried/)
  const failed = await runFixture(harness({ worker: { run: async () => ({ status: 'failed', outputs: {}, reason: 'red' }) } }), 'research.yaml')
  const fresh = harness({ table: memoryTable(new Map([[failed.id, failed]])) })
  await assert.rejects(() => fresh.controller.retry(failed.id, { worker: 'nobody', caller, reason: 'x' }), /no enabled Worker nobody/)
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
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available())
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
