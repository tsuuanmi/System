import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryArtifacts, memoryWorkTable } from '../../../test-support/memory.ts'
import { GOAL_KIND, TASK_KIND, Capabilities, WorkController, goalSchema, goalStore, directTask, resolvedSpecSchema, spendOf, taskSchema, type Goal, type ResolvedSpec, type SpecStore, type WorkerRequest, type WorkerResult } from '../src/index.ts'

const human = { type: 'human', operatorId: 'tan' } as const
const producer = { type: 'operator', ref: 'tan' } as const
const id = (c: string) => `sha256:${c.repeat(64)}`

type Usage = WorkerResult['usage']

/** A controller over real Artifacts and a fake Worker whose attempts report the usage queued for them. */
function setup() {
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...GOAL_KIND, content: goalSchema }, { kind: 'workflow-spec', schemaVersion: 1, content: resolvedSpecSchema })
  const specs: SpecStore = {
    async putSpec(spec) { return (await artifacts.put({ kind: 'workflow-spec', schemaVersion: 1, content: spec, classification: 'public', producer })).id },
    getSpec: (specId) => { const r = artifacts.get(specId); return r.state === 'stored' ? r.envelope.content as ResolvedSpec : undefined },
    exists: (artifactId) => artifacts.get(artifactId).state === 'stored',
    kindOf: (artifactId) => { const r = artifacts.get(artifactId); return r.state === 'stored' ? r.envelope.kind : undefined },
    putVerdict: async () => { throw new Error('no verify step') },
    goals: goalStore(artifacts),
  }
  const usages: Usage[] = []
  const requests: WorkerRequest[] = []
  const capabilities = new Capabilities()
  capabilities.registerWorker({
    ref: 'fake/w', capabilities: ['code-write'],
    async run(request) {
      requests.push(request)
      const out = (await artifacts.put({ kind: 'task', schemaVersion: 1, content: { instructions: `out ${requests.length}` }, classification: 'public', producer })).id
      return { status: 'succeeded', outputs: { result: out }, usage: usages.shift() }
    },
  })
  const table = memoryWorkTable()
  const controller = new WorkController(table, specs, capabilities)
  const task = async (instructions: string, context?: string[]) => (await artifacts.put({ ...TASK_KIND, content: { instructions, ...(context ? { context } : {}) }, inputs: context ?? [], classification: 'public', producer })).id
  const note = async (text: string) => (await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: new TextEncoder().encode(text), mediaType: 'text/plain', classification: 'public', producer })).id
  const goal = async (content: Omit<Goal, 'context'> & { context?: string[] }, supersedes: string[] = []) =>
    (await artifacts.put({ ...GOAL_KIND, content: { context: [await note('charter')], ...content }, inputs: [], supersedes, classification: 'public', producer })).id
  const submit = async (goalId?: string, input?: string) => controller.admit({
    spec: directTask(['code-write'], true, capabilities.available()), input: input ?? await task('do it'), caller: human, source: { kind: 'direct-task' }, ...(goalId ? { goal: goalId } : {}),
  })
  return { artifacts, controller, table, usages, requests, task, note, goal, submit }
}

const observed = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): Usage => ({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, source: 'test' })

test('goal@1 is strict: aim, scope, a positive budget and context Artifact IDs', () => {
  const ok = { aim: 'a', scope: 's', budget: { attempts: 3, tokens: 1000 }, context: [id('1')] }
  assert.ok(goalSchema.safeParse(ok).success)
  assert.ok(goalSchema.safeParse({ ...ok, budget: {} }).success)
  for (const bad of [{ ...ok, extra: 1 }, { ...ok, budget: { attempts: 0 } }, { ...ok, budget: { tokens: 1.5 } }, { ...ok, budget: { cost: 1 } }, { ...ok, context: ['nope'] }, { ...ok, aim: undefined }, { ...ok, scope: undefined }, { ...ok, budget: undefined }]) {
    assert.equal(goalSchema.safeParse(bad).success, false, JSON.stringify(bad))
  }
})

test('a raise is a new goal that supersedes the old one; the old one resolves to the newest', async () => {
  const s = setup()
  const first = await s.goal({ aim: 'a', scope: 's', budget: { attempts: 1 } })
  const raised = await s.goal({ aim: 'a', scope: 's', budget: { attempts: 5 } }, [first])
  const view = s.controller.goalView(first)
  assert.equal(view.id, first)
  assert.equal(view.current.id, raised)
  assert.deepEqual(view.current.goal.budget, { attempts: 5 })
  assert.deepEqual(view.goal.budget, { attempts: 1 })
  assert.equal(s.controller.goalView(raised).current.id, raised)
  assert.throws(() => s.controller.goalView(id('9')), /no Goal/)
})

test('admission without a Goal is unchanged; with one the admitted event names it and the Task carries the Goal context', async () => {
  const s = setup()
  const plain = await s.submit()
  assert.equal(plain.events[0]!.type === 'admitted' && 'goal' in plain.events[0], false)
  const charter = await s.note('principles')
  const goal = await s.goal({ aim: 'a', scope: 's', budget: {}, context: [charter] })
  const own = await s.note('own')
  const input = await s.task('do it', [own])
  const record = await s.submit(goal, input)
  const admitted = record.events[0]!
  assert.equal(admitted.type === 'admitted' && admitted.goal, goal)
  assert.notEqual(record.state.input, input, 'the Task is wrapped')
  const wrapped = s.artifacts.get(record.state.input!)
  assert.equal(wrapped.state === 'stored' && wrapped.envelope.kind, 'task')
  const content = wrapped.state === 'stored' ? wrapped.envelope.content as { instructions: string; context: string[] } : undefined
  assert.equal(content?.instructions, 'do it')
  assert.deepEqual(content?.context, [charter, own])
  assert.equal(s.controller.replay(record.id).matches, true)
  await assert.rejects(s.submit(id('7')), /no Goal/)
})

test('admission is refused once the spend reached the budget, at the limit and not before', async () => {
  const s = setup()
  const goal = await s.goal({ aim: 'a', scope: 's', budget: { attempts: 2 } })
  const first = await s.submit(goal)
  await s.controller.run(first.id)
  assert.equal(s.controller.goalView(goal).spend.attempts, 1)
  const second = await s.submit(goal)
  await s.controller.run(second.id)
  assert.equal(s.controller.goalView(goal).spend.attempts, 2)
  await assert.rejects(s.submit(goal), /budget.*2 attempts/)
  assert.equal(s.controller.list().length, 2, 'nothing was admitted')
  // Without a Goal, nothing is limited.
  await s.submit()
})

test('the token budget counts fresh input plus output, not cache reads', async () => {
  const s = setup()
  const goal = await s.goal({ aim: 'a', scope: 's', budget: { tokens: 100 } })
  s.usages.push(observed(1000, 40, 900, 50)) // fresh 50 + output 40 = 90
  await s.controller.run((await s.submit(goal)).id)
  assert.equal(s.controller.goalView(goal).spend.tokens, 90)
  await s.submit(goal)
  s.usages.push(observed(60, 20, 0, 0)) // +80 = 170
  await s.controller.run((await s.submit(goal)).id)
  assert.equal(s.controller.goalView(goal).spend.tokens, 170)
  await assert.rejects(s.submit(goal), /budget.*100 tokens/)
})

test('unknown usage counts as an attempt, not as tokens, and is reported as unknown', async () => {
  const s = setup()
  const goal = await s.goal({ aim: 'a', scope: 's', budget: { attempts: 1, tokens: 1_000_000 } })
  await s.controller.run((await s.submit(goal)).id)
  const { spend } = s.controller.goalView(goal)
  assert.equal(spend.attempts, 1)
  assert.equal(spend.tokens, 0)
  assert.equal(spend.unknownAttempts, 1)
  await assert.rejects(s.submit(goal), /budget/)
})

test('a raise lets admission continue, and the spend of the old versions still counts', async () => {
  const s = setup()
  const first = await s.goal({ aim: 'a', scope: 's', budget: { attempts: 1 } })
  const running = await s.submit(first)
  await s.controller.run(running.id)
  await assert.rejects(s.submit(first), /budget/)
  const raised = await s.goal({ aim: 'a', scope: 's', budget: { attempts: 2 } }, [first])
  const next = await s.submit(raised)
  await s.controller.run(next.id)
  assert.equal(s.controller.goalView(first).spend.attempts, 2, 'the old and the new Goal share one spend')
  assert.equal(s.controller.goalView(raised).spend.attempts, 2)
  // Naming the old version is judged by the newest one's budget.
  await assert.rejects(s.submit(first), /budget.*2 attempts/)
  const again = await s.goal({ aim: 'a', scope: 's', budget: { attempts: 3 } }, [raised])
  await s.submit(first)
  assert.equal(s.controller.goalView(first).current.id, again)
})

test('a running Work is never stopped by the budget', async () => {
  const s = setup()
  const goal = await s.goal({ aim: 'a', scope: 's', budget: { attempts: 1 } })
  const a = await s.submit(goal)
  const b = await s.submit(goal)
  const [x, y] = await Promise.all([s.controller.run(a.id), s.controller.run(b.id)])
  assert.deepEqual([x.state.status, y.state.status], ['succeeded', 'succeeded'])
  assert.equal(s.controller.goalView(goal).spend.attempts, 2)
})

test('the spend is a fold of the records: replayed from the events it equals the stored records\' fold', async () => {
  const s = setup()
  const first = await s.goal({ aim: 'a', scope: 's', budget: {} })
  const raised = await s.goal({ aim: 'a', scope: 's', budget: { attempts: 9 } }, [first])
  s.usages.push(observed(100, 10, 20, 5), undefined, observed(7, 3), { inputTokens: 40, outputTokens: 2, source: 'test' })
  for (const g of [first, raised, raised, raised]) await s.controller.run((await s.submit(g)).id)
  const stored = s.controller.list()
  const view = s.controller.goalView(raised).spend
  assert.deepEqual(spendOf(stored, new Set([first, raised])), view)
  assert.deepEqual(view, { works: 4, attempts: 4, tokens: 75 + 10 + 7 + 3 + 2, unknownAttempts: 1, unsplitAttempts: 1 })
  // The same events with their states folded again give the same spend.
  const replayed = stored.map((record) => ({ ...record, state: s.controller.replay(record.id).state }))
  assert.deepEqual(spendOf(replayed, new Set([first, raised])), view)
  assert.deepEqual(spendOf(stored, new Set([id('5')])), { works: 0, attempts: 0, tokens: 0, unknownAttempts: 0, unsplitAttempts: 0 })
})
