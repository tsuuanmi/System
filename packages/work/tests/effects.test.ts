/**
 * External effects through the controller with a scripted provider whose
 * "remote" is a map: intent before effect, effect before record, read-only
 * reconciliation after any unknown outcome, never a blind second apply, and
 * human-only approval.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { memoryWorkTable, until } from '../../../test-support/memory.ts'
import { WorkController, type SpecStore } from '../src/controller.ts'
import type { Verdict } from '../src/kinds.ts'
import type { Caller, WorkRecord } from '../src/record.ts'
import { Capabilities, type EffectIntent, type EffectPort, type Reconciled, type VerifyResult } from '../src/registry.ts'
import { parseWorkflow, resolve, type ResolvedSpec } from '../src/workflow.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SE = readFileSync(join(repo, 'workflows', 'software-engineering.yaml'), 'utf8')
const human: Caller = { type: 'human', operatorId: 'tan' }
const agent: Caller = { type: 'agent', operatorId: 'tan' }
const id = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
interface Remote {
  /** operationId -> what is published. */
  published: Map<string, Record<string, string>>
  applies: number
}

interface Options {
  verdict?: VerifyResult['verdict']
  approval?: (intent: EffectIntent) => string | undefined
  apply?: (intent: EffectIntent, remote: Remote) => Promise<{ state: 'applied' | 'failed'; reason: string; detail: Record<string, string> }>
  reconcile?: (intent: EffectIntent, remote: Remote) => Promise<Reconciled>
  validate?: EffectPort['validate']
}

function world(rows = new Map<string, WorkRecord>(), remote: Remote = { published: new Map(), applies: 0 }) {
  const stored = new Set<string>()
  const kinds = new Map<string, string>()
  const specs = new Map<string, ResolvedSpec>()
  const store = (text: string, kind: string) => { const artifactId = id(text); stored.add(artifactId); kinds.set(artifactId, kind); return artifactId }
  const table = memoryWorkTable(rows)
  const specStore: SpecStore = {
    async putSpec(spec) { const specId = store(JSON.stringify(spec), 'workflow-spec'); specs.set(specId, spec); return specId },
    getSpec: (specId) => structuredClone(specs.get(specId)),
    exists: (artifactId) => stored.has(artifactId),
    kindOf: (artifactId) => kinds.get(artifactId),
    async putVerdict(verdict: Verdict) { return store(JSON.stringify(verdict), 'verdict') },
  }
  return { rows, remote, table, specStore, store, kinds }
}

function controller(w: ReturnType<typeof world>, options: Options = {}) {
  const capabilities = new Capabilities()
  capabilities.registerWorker({
    ref: 'coder', capabilities: ['code-write'],
    async run(request) { return { status: 'succeeded', outputs: { change: w.store(`change/${request.attemptId}`, 'git-tree') } } },
  })
  capabilities.registerVerifier({
    ref: 'checks', version: '1', capabilities: ['code.required-checks'], accepts: ['git-tree'],
    async criteria() { return w.store('criteria', 'checks') },
    async verify(r) { return { verdict: options.verdict ?? 'pass', reason: 'scripted', subject: r.subject, criteria: r.criteria, evidence: [w.store(`evidence/${r.attemptId}`, 'check-run')] } },
  })
  capabilities.registerEffect({
    ref: 'publisher', version: '1', capabilities: ['git.publish'], accepts: ['git-tree'],
    validate: options.validate ?? (() => undefined),
    approval: options.approval ?? (() => undefined),
    apply: (intent) => (options.apply ?? (async (i, remote) => {
      remote.applies += 1
      remote.published.set(i.operationId, { branch: `system/${i.workId}`, commit: i.subject })
      return { state: 'applied', reason: 'pushed and opened a draft PR', detail: remote.published.get(i.operationId)! }
    }))(intent, w.remote),
    reconcile: (intent) => (options.reconcile ?? (async (i, remote) => {
      const found = remote.published.get(i.operationId)
      return found ? { state: 'applied', reason: 'found on the remote', detail: found } : { state: 'absent', reason: 'not on the remote' }
    }))(intent, w.remote),
  })
  return new WorkController(w.table, w.specStore, capabilities)
}

async function admit(c: WorkController, w: ReturnType<typeof world>, yaml = SE) {
  const capabilities = (c as unknown as { capabilities: Capabilities }).capabilities
  const spec = resolve(parseWorkflow(yaml), capabilities.available(), (name) => readFileSync(join(repo, 'workflows', name), 'utf8'))
  return c.admit({ spec, input: w.store('task', 'task'), caller: human, source: { kind: 'workflow-file' } })
}

const types = (record: WorkRecord) => record.events.map((e) => e.type)

test('a verified change is published once: intent recorded before the effect, outcome after', async () => {
  const w = world()
  const c = controller(w)
  const done = await c.run((await admit(c, w)).id)
  assert.equal(done.state.status, 'succeeded', done.state.reason)
  assert.deepEqual(types(done), ['admitted', 'dispatched', 'observed', 'dispatched', 'verified', 'effect-intended', 'effect-observed', 'terminal'])
  assert.equal(w.remote.applies, 1)
  const intended = done.events.find((e) => e.type === 'effect-intended')
  const observed = done.events.find((e) => e.type === 'effect-observed')
  assert.ok(intended?.type === 'effect-intended' && observed?.type === 'effect-observed')
  assert.equal(intended.subject, done.state.steps.implement!.outputs.change)
  assert.match(intended.operationId, /^op:[0-9a-f]{64}$/)
  assert.equal(observed.operationId, intended.operationId)
  assert.deepEqual(observed.detail, { branch: `system/${done.id}`, commit: intended.subject })
  assert.deepEqual(done.state.effects[intended.operationId], { stepId: 'publish', state: 'applied', detail: observed.detail })
  assert.equal(c.replay(done.id).matches, true)
})

test('nothing is published unless the required verdict passed on that exact subject', async () => {
  const failing = world()
  const failed = await controller(failing, { verdict: 'fail' }).run((await admit(controller(failing, { verdict: 'fail' }), failing)).id)
  assert.equal(failed.state.status, 'failed')
  assert.ok(!types(failed).includes('effect-intended'))
  // ADR-0004 decision 12: the push happens only after a pass; an inconclusive verdict cannot be approved past it.
  const unsure = world()
  const notPublished = await controller(unsure, { verdict: 'inconclusive' }).run((await admit(controller(unsure, { verdict: 'inconclusive' }), unsure)).id)
  assert.equal(notPublished.state.status, 'failed')
  assert.match(notPublished.state.reason!, /publish needs a passing verdict on its subject: checks\.checks=inconclusive/)
  assert.equal(notPublished.state.awaiting, undefined)
  assert.equal(unsure.remote.applies + failing.remote.applies, 0)
})

test('a host lost after the intent and before the effect: reconcile finds nothing, the effect is applied once', async () => {
  const w = world()
  const first = controller(w, { apply: () => new Promise(() => {}) })
  const admitted = await admit(first, w)
  void first.run(admitted.id)
  await until(() => types(w.rows.get(admitted.id)!).includes('effect-intended'), 'the effect intent')
  const done = await controller(w).run(admitted.id)
  assert.equal(done.state.status, 'succeeded')
  assert.equal(w.remote.applies, 1)
  const observed = done.events.filter((e) => e.type === 'effect-observed')
  assert.deepEqual(observed.map((e) => e.type === 'effect-observed' && [e.state, e.reason]), [['absent', 'not on the remote'], ['applied', 'pushed and opened a draft PR']])
})

test('a host lost after the remote applied the effect but before it was recorded: reconcile records it, nothing is applied again', async () => {
  const w = world()
  const first = controller(w, { apply: async (intent, remote) => {
    remote.applies += 1
    remote.published.set(intent.operationId, { branch: 'system/x', commit: intent.subject })
    return new Promise(() => {})
  } })
  const admitted = await admit(first, w)
  void first.run(admitted.id)
  await until(() => w.remote.applies > 0, 'the remote effect')
  const done = await controller(w).run(admitted.id)
  assert.equal(done.state.status, 'succeeded')
  assert.equal(w.remote.applies, 1, 'no duplicate effect')
  const observed = done.events.filter((e) => e.type === 'effect-observed')
  assert.deepEqual(observed.map((e) => e.type === 'effect-observed' && e.state), ['applied'])
})

test('an outcome reconciliation cannot establish holds the Work and applies nothing', async () => {
  const w = world()
  const first = controller(w, { apply: () => new Promise(() => {}) })
  const admitted = await admit(first, w)
  void first.run(admitted.id)
  await until(() => types(w.rows.get(admitted.id)!).includes('effect-intended'), 'the effect intent')
  const held = await controller(w, { reconcile: async () => ({ state: 'unknown', reason: 'the remote did not answer' }) }).run(admitted.id)
  assert.equal(held.state.status, 'held')
  assert.match(held.state.reason!, /outcome of publish is unknown: the remote did not answer/)
  assert.equal(w.remote.applies, 0)
})

test('Work held on an unknown outcome resumes when a later run can read the remote', async () => {
  const w = world()
  const first = controller(w, { apply: async (intent, remote) => {
    remote.applies += 1
    remote.published.set(intent.operationId, { branch: 'system/x', commit: intent.subject })
    return new Promise(() => {})
  } })
  const admitted = await admit(first, w)
  void first.run(admitted.id)
  await until(() => w.remote.applies > 0, 'the remote effect')
  const held = await controller(w, { reconcile: async () => ({ state: 'unknown', reason: 'the remote did not answer' }) }).run(admitted.id)
  assert.equal(held.state.status, 'held')
  const resumed = await controller(w).run(admitted.id)
  assert.equal(resumed.state.status, 'succeeded', resumed.state.reason)
  assert.equal(w.remote.applies, 1, 'no second apply')
  assert.deepEqual(resumed.events.filter((e) => e.type === 'effect-observed').map((e) => e.type === 'effect-observed' && e.state), ['unknown', 'applied'])
})

test('an apply that throws is reconciled, never retried blindly', async () => {
  const w = world()
  const c = controller(w, { apply: async () => { throw new Error('connection reset') } })
  const done = await c.run((await admit(c, w)).id)
  assert.equal(done.state.status, 'failed')
  assert.match(done.state.reason!, /publish failed: connection reset; the remote shows nothing published/)
  assert.equal(w.remote.applies, 0)
})

test('an effect needing approval holds the Work; only a human approves; a denial fails it', async () => {
  const approval = (intent: EffectIntent) => (intent.params.ready ? 'marking the pull request ready for review' : undefined)
  const yaml = `${SE.replace('params: { merge: true }', 'params: { ready: true }')}`
  const w = world()
  const c = controller(w, { approval })
  const held = await c.run((await admit(c, w, yaml)).id)
  assert.equal(held.state.status, 'held')
  assert.match(held.state.reason!, /publish awaits operator approval: marking the pull request ready for review/)
  assert.equal(w.remote.applies, 0)
  await assert.rejects(() => c.decide(held.id, { decision: 'approved', caller: agent, reason: 'lgtm' }), /only a human operator approves/)
  const done = await c.decide(held.id, { decision: 'approved', caller: human, reason: 'reviewed the diff' })
  assert.equal(done.state.status, 'succeeded')
  assert.equal(w.remote.applies, 1)
  const decided = done.events.find((e) => e.type === 'decided')
  assert.deepEqual(decided?.type === 'decided' && [decided.stepId, decided.decision, decided.caller.operatorId], ['publish', 'approved', 'tan'])

  const w2 = world()
  const c2 = controller(w2, { approval })
  const held2 = await c2.run((await admit(c2, w2, yaml)).id)
  const denied = await c2.decide(held2.id, { decision: 'denied', caller: human, reason: 'not yet' })
  assert.equal(denied.state.status, 'failed')
  assert.match(denied.state.reason!, /publish denied by tan: not yet/)
  assert.equal(w2.remote.applies, 0)
})

test('an inconclusive verdict is accepted only by a human decision', async () => {
  const yaml = SE.replace(/  - id: publish[\s\S]*?(?=  - id: accept)/, '').replace('dependsOn: [publish]', 'dependsOn: [checks]')
  const w = world()
  const c = controller(w, { verdict: 'inconclusive' })
  const held = await c.run((await admit(c, w, yaml)).id)
  assert.equal(held.state.status, 'held')
  await assert.rejects(() => c.decide(held.id, { decision: 'approved', caller: agent, reason: 'x' }), /only a human operator approves/)
  const done = await c.decide(held.id, { decision: 'approved', caller: human, reason: 'the source is right; the page moved' })
  assert.equal(done.state.status, 'succeeded')
  assert.match(done.state.reason!, /accepted by tan despite inconclusive checks\.checks: the source is right; the page moved/)
  await assert.rejects(() => c.decide(done.id, { decision: 'approved', caller: human, reason: 'again' }), /nothing awaits a decision/)
})

test('parameters the provider refuses refuse admission; no Work is created', async () => {
  const w = world()
  const c = controller(w, { validate: (_, params) => { if ('base' in params) throw new Error('base is not configurable here') } })
  await assert.rejects(() => admit(c, w, SE.replace('params: { merge: true }', 'params: { base: dev }')), /publish: publisher refuses its params: base is not configurable here/)
  assert.equal(w.rows.size, 0)
})

test('after failed checks, retry --step implement publishes the new subject, never the rejected one', async () => {
  const w = world()
  let verdict: VerifyResult['verdict'] = 'fail'
  const c = controller(w, { get verdict() { return verdict } } as Options)
  const failed = await c.run((await admit(c, w)).id)
  assert.equal(failed.state.status, 'failed')
  const rejected = failed.state.steps.implement!.outputs.change
  verdict = 'pass'
  const done = await c.retry(failed.id, { step: 'implement', caller: human, reason: 'rework' })
  assert.equal(done.state.status, 'succeeded')
  const intents = done.events.filter((e) => e.type === 'effect-intended')
  assert.equal(intents.length, 1)
  assert.equal(intents[0]?.type === 'effect-intended' && intents[0].subject, done.state.steps.implement!.outputs.change)
  assert.notEqual(done.state.steps.implement!.outputs.change, rejected)
  assert.equal(w.remote.applies, 1)
})

test('retry --step publish redoes only the effect: the Worker and the checks are not run again', async () => {
  const w = world()
  let failing = true
  const c = controller(w, { apply: async (intent, remote) => {
    if (failing) throw new Error('GitHub answered 502')
    remote.applies += 1
    remote.published.set(intent.operationId, { commit: intent.subject })
    return { state: 'applied', reason: 'published', detail: { commit: intent.subject } }
  } })
  const failed = await c.run((await admit(c, w)).id)
  assert.equal(failed.state.status, 'failed')
  failing = false
  const done = await c.retry(failed.id, { step: 'publish', caller: human, reason: 'transient API error' })
  assert.equal(done.state.status, 'succeeded', done.state.reason)
  assert.equal(done.events.filter((e) => e.type === 'dispatched').length, 2, 'implement and checks ran once each')
  const intents = done.events.filter((e) => e.type === 'effect-intended')
  assert.equal(intents.length, 2)
  assert.equal(intents[0]?.type === 'effect-intended' && intents[0].operationId, intents[1]?.type === 'effect-intended' && intents[1].operationId, 'the same subject is the same operation')
  assert.equal(w.remote.applies, 1)
  assert.equal(c.replay(failed.id).matches, true)
})

test('an effect is told the checks it requires, with their pinned criteria, also when rebuilt after a lost host', async () => {
  const w = world()
  const told: EffectIntent[] = []
  const first = controller(w, { apply: (intent) => { told.push(intent); return new Promise(() => {}) } })
  const admitted = await admit(first, w)
  void first.run(admitted.id)
  await until(() => told.length === 1, 'the first apply')
  const criteria = w.rows.get(admitted.id)!.state.criteria
  const required = Object.keys(criteria).map((id) => ({ capability: 'code.required-checks', criteria: criteria[id]! }))
  assert.ok(required.length > 0)
  assert.deepEqual(told[0]!.required, required)
  const done = await controller(w, { apply: async (intent, remote) => { told.push(intent); remote.applies++; remote.published.set(intent.operationId, { branch: 'b', commit: intent.subject }); return { state: 'applied', reason: 'done', detail: {} } } }).run(admitted.id)
  assert.equal(done.state.status, 'succeeded', done.state.reason)
  assert.deepEqual(told.at(-1)!.required, required, 'rebuilt from the record after the host was lost')
})
