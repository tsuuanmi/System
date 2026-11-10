import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { memoryWorkTable } from '../../../test-support/memory.ts'
import { WorkController, type SpecStore } from '../src/controller.ts'
import type { QuotaReading } from '../src/headroom.ts'
import { Capabilities, type WorkerPort } from '../src/registry.ts'
import { parseWorkflow, resolve, type ResolvedSpec } from '../src/workflow.ts'

const caller = { type: 'human', operatorId: 'tan' } as const
const id = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const WORKFLOW = 'schema: system.workflow/v1\nid: t\nversion: 1\nsteps:\n  - id: a\n    capabilities: [code-write]\n    outputs: [x]\n'
const read = (five: number, seven: number, resetsAt?: string): QuotaReading => ({ windows: { five_hour: { percentUsed: five, ...(resetsAt ? { resetsAt } : {}) }, seven_day: { percentUsed: seven } } })

function setup(accounts: { ref: string; priority?: 'primary' | 'secondary'; reading?: QuotaReading }[]) {
  const stored = new Set<string>()
  const specs = new Map<string, ResolvedSpec>()
  const store: SpecStore = {
    unchangedBase: () => undefined,
    kindOf: (artifactId) => (specs.has(artifactId) ? 'workflow-spec' : stored.has(artifactId) ? 'output' : undefined),
    async putVerdict() { throw new Error('no verdict here') },
    async putSpec(spec) { const specId = id(JSON.stringify(spec)); specs.set(specId, structuredClone(spec)); stored.add(specId); return specId },
    getSpec: (specId) => structuredClone(specs.get(specId)),
    exists: (artifactId) => stored.has(artifactId),
    taskOf: () => undefined,
    withNote: async () => { throw new Error('no Item in this test') },
  }
  const readings = new Map(accounts.map((a) => [a.ref, a.reading]))
  const quotaCalls: string[] = []
  const ran: string[] = []
  const capabilities = new Capabilities()
  for (const a of accounts) {
    const worker: WorkerPort = {
      ref: a.ref, capabilities: ['code-write'], priority: a.priority,
      async quota() { quotaCalls.push(a.ref); const r = readings.get(a.ref); if (!r) throw new Error('no reader'); return r },
      async run(request) {
        ran.push(a.ref)
        const out = id(`${request.attemptId}/x`)
        stored.add(out)
        return { status: 'succeeded', outputs: { x: out } }
      },
    }
    capabilities.registerWorker(worker)
  }
  const table = memoryWorkTable()
  const controller = new WorkController(table, store, capabilities)
  const admit = async () => {
    const input = id('task')
    stored.add(input)
    return (await controller.admit({ spec: resolve(parseWorkflow(WORKFLOW), capabilities.available(), () => ''), input, caller, source: { kind: 'workflow-file' } })).id
  }
  return { controller, readings, quotaCalls, ran, admit, table }
}

const dispatchedOf = (record: { events: { type: string }[] }) => record.events.find((e) => e.type === 'dispatched') as Extract<WorkerEvent, { type: 'dispatched' }>
type WorkerEvent = import('../src/record.ts').WorkEvent

test('the step goes to the primary under the ceiling, and the record keeps each reading as a reason', async () => {
  const t = setup([{ ref: 'sec', reading: read(5, 5) }, { ref: 'prim', priority: 'primary', reading: read(43, 31) }])
  const done = await t.controller.run(await t.admit())
  assert.deepEqual(t.ran, ['prim'])
  assert.deepEqual(dispatchedOf(done).candidates, [
    { ref: 'sec', selected: false, reason: 'headroom 95% (5h 5%, 7d 5%)' },
    { ref: 'prim', selected: true, reason: 'primary under 80% (5h 43%, 7d 31%)' },
  ])
})

test('a primary over the ceiling gives the step to the free Account with the most headroom; an unreadable one is last', async () => {
  const t = setup([{ ref: 'broken' }, { ref: 'prim', priority: 'primary', reading: read(91, 10) }, { ref: 'a', reading: read(40, 60) }, { ref: 'b', reading: read(30, 20) }])
  const done = await t.controller.run(await t.admit())
  assert.deepEqual(t.ran, ['b'])
  const reasons = Object.fromEntries(dispatchedOf(done).candidates.map((c) => [c.ref, c.reason]))
  assert.equal(reasons.prim, 'over 80% (5h 91%)')
  assert.match(reasons.b!, /^headroom 70%/)
  assert.equal(reasons.broken, 'quota unreadable: no reader')
})

test('a step with every Account over the ceiling waits and spends no attempt, then starts when a reading drops', { timeout: 10_000 }, async () => {
  const reset = new Date(Date.now() + 150).toISOString()
  const t = setup([{ ref: 'a', reading: read(95, 10, reset) }, { ref: 'b', reading: read(10, 90, new Date(Date.now() + 60_000).toISOString()) }])
  const workId = await t.admit()
  // The retry timer is unref'd (it never holds a process open); the test holds the loop open.
  const keepAlive = setInterval(() => undefined, 1000)
  const running = t.controller.run(workId).finally(() => clearInterval(keepAlive))
  await new Promise((resolve) => setTimeout(resolve, 50))
  const waiting = t.controller.live(workId)
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0]!.waiting, 'quota')
  assert.equal(waiting[0]!.resetsAt, reset, 'the earliest reset')
  assert.deepEqual(t.table.get(workId)!.events.map((e) => e.type), ['admitted'], 'no attempt is spent')
  assert.deepEqual(t.ran, [])
  t.readings.set('a', read(2, 10))
  const done = await running
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(t.ran, ['a'])
  assert.deepEqual(t.controller.live(workId), [])
  assert.equal(done.events.filter((e) => e.type === 'dispatched').length, 1)
})

test('replay reads the recorded readings and never asks quota again', async () => {
  const t = setup([{ ref: 'a', reading: read(10, 10) }, { ref: 'b', priority: 'primary', reading: read(95, 0) }])
  const workId = await t.admit()
  await t.controller.run(workId)
  const calls = t.quotaCalls.length
  assert.ok(calls > 0)
  assert.equal(t.controller.replay(workId).matches, true)
  await new WorkController(t.table, (t.controller as unknown as { specs: SpecStore }).specs, (t.controller as unknown as { capabilities: Capabilities }).capabilities).run(workId)
  assert.equal(t.quotaCalls.length, calls)
})
