import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { memoryWorkTable, snapshotWorkTable } from '../../../test-support/memory.ts'
import { LocalControl } from '../../../test-support/process.ts'
import { WorkController, type HostIdentity, type SpecStore, type WorkTable } from '../src/controller.ts'
import { WorkError } from '../src/errors.ts'
import { fold, type WorkRecord } from '../src/record.ts'
import type { Verdict } from '../src/kinds.ts'
import { Capabilities, type VerifierPort, type VerifyResult, type WorkerPort, type WorkerRequest, type WorkerResult } from '../src/registry.ts'
import { WorkflowError, directTask, parseWorkflow, resolve, type ResolvedSpec } from '../src/workflow.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const fixture = (name: string) => readFileSync(join(repo, 'workflows', name), 'utf8')
const caller = { type: 'human', operatorId: 'tan' } as const
const id = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

function memorySpecs(): SpecStore & { stored: Set<string>; verdicts: Map<string, Verdict> } {
  const specs = new Map<string, ResolvedSpec>()
  const stored = new Set<string>()
  const verdicts = new Map<string, Verdict>()
  return {
    stored,
    verdicts,
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

function harness(options: { verdict?: VerifyResult['verdict']; worker?: Partial<WorkerPort>; verifier?: Partial<VerifierPort>; table?: WorkTable; specs?: ReturnType<typeof memorySpecs>; control?: LocalControl; host?: HostIdentity } = {}): Harness {
  // Tests that read `table.rows` pass no table; the snapshot tests read their own `disk`.
  const table = (options.table ?? memoryWorkTable()) as ReturnType<typeof memoryWorkTable>
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
  return { controller: new WorkController(table, specs, capabilities, options.control ?? new LocalControl(), options.host), capabilities, calls, verdicts, table, specs }
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
  assert.deepEqual(dispatched && 'inputs' in dispatched && dispatched.inputs, { subject: done.state.steps.implement!.outputs.change, criteria: done.state.criteria.checks })
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
  const table = memoryWorkTable()
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
  const spec = resolve(parseWorkflow(fixture('software-engineering.yaml').replace(/  - id: publish[\s\S]*$/, '')), h.capabilities.available())
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
  const bare = new WorkController(h.table, h.specs, new Capabilities(), new LocalControl())
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
  await assert.rejects(() => h.controller.retry(done.id, { caller, reason: 'x' }), /only failed, cancelled or held Work is retried/)
  const failed = await runFixture(harness({ worker: { run: async () => ({ status: 'failed', outputs: {}, reason: 'red' }) } }), 'research.yaml')
  const fresh = harness({ table: memoryWorkTable(new Map([[failed.id, failed]])) })
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

test('a tier is a capability: a step asking for a tier no Worker offers is refused at preflight', () => {
  const capabilities = new Capabilities()
  capabilities.registerWorker({ ref: 'claude', capabilities: ['code-write', 'tier.standard', 'tier.frontier'], run: async () => ({ status: 'failed', outputs: {} }) })
  const workflow = (tier: string) => `schema: system.workflow/v1\nid: t\nversion: 1\nsteps:\n  - id: a\n    capabilities: [code-write, ${tier}]\n    outputs: [x]\n`
  assert.doesNotThrow(() => resolve(parseWorkflow(workflow('tier.frontier')), capabilities.available()))
  assert.throws(() => resolve(parseWorkflow(workflow('tier.economy')), capabilities.available()), /needs Worker capability tier.economy, which no enabled Worker provides/)
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
  assert.deepEqual([stored.subject, stored.criteria, stored.verdict, stored.verifier], [done.state.steps.implement!.outputs.change, done.state.criteria.checks, 'pass', { ref: 'fake-verifier', version: '1' }])
  assert.equal(stored.evidence.length, 1)
})

test('criteria a verifier cannot pin refuse admission, and no Work is created', async () => {
  const h = harness({ verifier: { async criteria() { throw new Error('no .system/checks.yaml at the base commit') } } })
  const spec = resolve(parseWorkflow(fixture('software-engineering.yaml')), h.capabilities.available())
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
  const firstChange = failed.state.steps.implement!.outputs.change
  await assert.rejects(() => h.controller.retry(failed.id, { caller, reason: 'x' }), /name one with --step/)
  verdict = 'pass'
  const done = await h.controller.retry(failed.id, { step: 'implement', caller, reason: 'fix the failing checks' })
  assert.equal(done.state.status, 'succeeded')
  const reopened = done.events.find((e) => e.type === 'reopened')
  assert.deepEqual(reopened?.type === 'reopened' && reopened.reset, ['implement', 'checks', 'publish', 'accept'])
  const verifiedSubjects = done.events.filter((e) => e.type === 'verified').map((e) => e.type === 'verified' && e.subject)
  assert.deepEqual(verifiedSubjects, [firstChange, done.state.steps.implement!.outputs.change])
  assert.notEqual(verifiedSubjects[1], firstChange)
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

test('a host lost during admission, after the spec was pinned and before the Work record, leaves no Work and runs nothing', async () => {
  const h = harness()
  h.table.put = async () => { throw new Error('host lost') }
  const spec = resolve(parseWorkflow(fixture('research.yaml')), h.capabilities.available())
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
  const spec = resolve(parseWorkflow(fixture('research.yaml')), v1.capabilities.available())
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

test('a host whose snapshot is older than the Work refuses to run it: no second dispatch, no event overwritten', async () => {
  const disk = new Map<string, WorkRecord>()
  const control = new LocalControl()
  const first = harness({ table: snapshotWorkTable(disk), control })
  const admitted = await first.controller.admit({ spec: directTask(['code-write'], false, first.capabilities.available()), caller, source: { kind: 'direct-task' } })
  // A second process opens the store now, then the first runs the Work to the end and releases it.
  const stale = harness({ table: snapshotWorkTable(disk), control, specs: first.specs })
  await first.controller.run(admitted.id)
  const finished = structuredClone(disk.get(admitted.id))
  await assert.rejects(() => stale.controller.run(admitted.id), /changed since this command started/)
  assert.equal(stale.calls.length, 0)
  assert.deepEqual(disk.get(admitted.id), finished)
})

test('a retry from a host whose snapshot is older than the Work is refused: the Work is not reopened twice', async () => {
  const disk = new Map<string, WorkRecord>()
  const control = new LocalControl()
  const specs = memorySpecs()
  let fail = true
  const worker: Partial<WorkerPort> = {
    async run(request): Promise<WorkerResult> {
      if (fail) return { status: 'failed', outputs: {}, reason: 'scripted' }
      const out = id(`${request.attemptId}/result`)
      specs.stored.add(out)
      return { status: 'succeeded', outputs: { result: out } }
    },
  }
  const first = harness({ table: snapshotWorkTable(disk), control, specs, worker })
  const admitted = await first.controller.admit({ spec: directTask(['code-write'], false, first.capabilities.available()), caller, source: { kind: 'direct-task' } })
  assert.equal((await first.controller.run(admitted.id)).state.status, 'failed')
  // A second process opens the store while the Work is failed; the first retries it to success.
  const stale = harness({ table: snapshotWorkTable(disk), control, specs, worker })
  fail = false
  assert.equal((await first.controller.retry(admitted.id, { caller, reason: 'again' })).state.status, 'succeeded')
  const finished = structuredClone(disk.get(admitted.id))
  await assert.rejects(() => stale.controller.retry(admitted.id, { caller, reason: 'again too' }), /changed since this command started/)
  assert.deepEqual(disk.get(admitted.id), finished)
})

test('a host that crashes between the table update and the second mark still fences a host loaded before the write', async () => {
  const disk = new Map<string, WorkRecord>()
  const control = new LocalControl()
  const first = harness({ table: snapshotWorkTable(disk), control })
  const admitted = await first.controller.admit({ spec: directTask(['code-write'], false, first.capabilities.available()), caller, source: { kind: 'direct-task' } })
  const stale = harness({ table: snapshotWorkTable(disk), control, specs: first.specs })
  // The first host dies after its first write reached the store, before the mark that follows it.
  const noteWrite = control.noteWrite.bind(control)
  const before = disk.get(admitted.id)!.events.length
  control.noteWrite = (workId, write) => {
    if (disk.get(workId)!.events.length > before) throw new Error('host lost')
    noteWrite(workId, write)
  }
  await assert.rejects(() => first.controller.run(admitted.id), /host lost/)
  control.noteWrite = noteWrite
  const written = structuredClone(disk.get(admitted.id))
  assert.ok(written!.events.length > 1)
  await assert.rejects(() => stale.controller.run(admitted.id), /changed since this command started/)
  assert.equal(stale.calls.length, 0)
  assert.deepEqual(disk.get(admitted.id), written)
})

test('a host whose snapshot is older than the Work refuses to cancel it: the record is unchanged', async () => {
  const disk = new Map<string, WorkRecord>()
  const control = new LocalControl()
  const first = harness({ table: snapshotWorkTable(disk), control })
  const admitted = await first.controller.admit({ spec: directTask(['code-write'], false, first.capabilities.available()), caller, source: { kind: 'direct-task' } })
  const stale = harness({ table: snapshotWorkTable(disk), control, specs: first.specs })
  // The first host cancels the Work after the second one loaded its copy.
  await first.controller.cancel(admitted.id, { reason: 'first', caller })
  const cancelled = structuredClone(disk.get(admitted.id))
  await assert.rejects(() => stale.controller.cancel(admitted.id, { reason: 'second', caller }), /changed since this command started/)
  assert.deepEqual(disk.get(admitted.id), cancelled)
})

test('a host whose snapshot is older than the Work refuses to decide on it: the record is unchanged', async () => {
  const disk = new Map<string, WorkRecord>()
  const control = new LocalControl()
  const first = harness({ table: snapshotWorkTable(disk), control, verdict: 'inconclusive' })
  const spec = resolve(parseWorkflow(fixture('research.yaml')), first.capabilities.available())
  const admitted = await first.controller.admit({ spec, input: await input(first), caller, source: { kind: 'workflow-file' } })
  const stale = harness({ table: snapshotWorkTable(disk), control, specs: first.specs })
  const held = await first.controller.run(admitted.id)
  assert.equal(held.state.status, 'held')
  const stored = structuredClone(disk.get(admitted.id))
  await assert.rejects(() => stale.controller.decide(admitted.id, { decision: 'approved', caller, reason: 'lgtm' }), /changed since this command started/)
  assert.deepEqual(disk.get(admitted.id), stored)
})

test('a Work with no mark runs normally', async () => {
  const disk = new Map<string, WorkRecord>()
  const first = harness({ table: snapshotWorkTable(disk) })
  const admitted = await first.controller.admit({ spec: directTask(['code-write'], false, first.capabilities.available()), caller, source: { kind: 'direct-task' } })
  // A host with a fresh control, so no host has marked the Work.
  const fresh = harness({ table: snapshotWorkTable(disk), specs: first.specs })
  assert.equal((await fresh.controller.run(admitted.id)).state.status, 'succeeded')
})

test('one controller runs, fails and retries its own Work without fencing itself', async () => {
  const specs = memorySpecs()
  let fail = true
  const worker: Partial<WorkerPort> = {
    async run(request): Promise<WorkerResult> {
      if (fail) return { status: 'failed', outputs: {}, reason: 'scripted' }
      const out = id(`${request.attemptId}/result`)
      specs.stored.add(out)
      return { status: 'succeeded', outputs: { result: out } }
    },
  }
  const h = harness({ table: snapshotWorkTable(new Map()), specs, worker })
  const admitted = await h.controller.admit({ spec: directTask(['code-write'], false, h.capabilities.available()), caller, source: { kind: 'direct-task' } })
  assert.equal((await h.controller.run(admitted.id)).state.status, 'failed')
  fail = false
  assert.equal((await h.controller.retry(admitted.id, { caller, reason: 'again' })).state.status, 'succeeded')
})
