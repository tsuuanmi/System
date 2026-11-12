import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { memoryWorkTable } from '../../../test-support/memory.ts'
import type { QuotaReport } from '../../agents/src/quota.ts'
import { WorkController, type SpecStore } from '../src/controller.ts'
import { Slots } from '../src/slots.ts'
import { TERMINAL, type WorkRecord } from '../src/record.ts'
import { Capabilities, type WorkerPort, type WorkerResult } from '../src/registry.ts'
import { directTask, type ResolvedSpec } from '../src/workflow.ts'

const caller = { type: 'human', operatorId: 'prefer-test' } as const
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const reading = (percentUsed: number): QuotaReport => ({ observedAt: '2026-11-12T00:00:00Z', windows: { five_hour: { percentUsed } } })
const webCaps = ['research', 'research.web']
type Account = Pick<WorkerPort, 'ref' | 'capabilities' | 'quota'> & { run?: () => Promise<WorkerResult> }
const accounts = (): Account[] => [
  { ref: 'web/fake', capabilities: webCaps },
  { ref: 'claude-code/fake', capabilities: ['research'], quota: async () => reading(5) },
]
const dispatched = (record: WorkRecord) => record.events.filter((e) => e.type === 'dispatched')
const turns = async () => { for (let n = 0; n < 30; n++) await new Promise<void>((resolve) => setImmediate(resolve)) }
async function eventually(condition: () => boolean, message: string) {
  for (const end = Date.now() + 5_000; !condition() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(condition(), message)
}
function registry(rows = accounts()) {
  const capabilities = new Capabilities()
  for (const row of rows) capabilities.registerWorker({
    ref: row.ref, get capabilities() { return row.capabilities }, quota: row.quota,
    run: row.run ?? (async () => ({ status: 'succeeded', outputs: {} })),
  })
  return capabilities
}
// The planned trailing optional argument is passed reflectively so these
// tests compile against the old signature and fail on behavior instead.
function route(capabilities: Capabilities, free?: (w: WorkerPort) => boolean, limited = new Set<string>(), prefer: string | undefined = 'research.web', readings = new Map([['claude-code/fake', reading(5)]])) {
  return Reflect.apply(capabilities.routeWorker, capabilities, [['research'], undefined, free, readings, limited, new Map(), prefer]) as ReturnType<Capabilities['routeWorker']>
}

test('prefers the role Account over a Claude Account with headroom', () => {
  const result = route(registry())
  assert.equal(result.selected?.ref, 'web/fake')
  assert.equal(result.candidates.find((c) => c.ref === 'claude-code/fake')?.reason, 'capable; research.web Account preferred')
  assert.ok(result.candidates.every((c) => typeof c.reason === 'string' && c.reason.length > 0))
})
test('falls back when the preferred Account has no free slot', () => {
  const result = route(registry(), (w) => w.ref !== 'web/fake')
  assert.equal(result.selected?.ref, 'claude-code/fake')
  assert.equal(result.candidates.find((c) => c.ref === 'web/fake')?.reason, 'capable; no free slot')
})
test('falls back when the preferred Account is unavailable', () => {
  const rows = accounts()
  Object.defineProperty(rows[0]!, 'capabilities', { get: () => [] })
  const result = route(registry(rows))
  assert.equal(result.selected?.ref, 'claude-code/fake')
})
test('falls back when the preferred Account is limited', () => {
  const result = route(registry(), undefined, new Set(['web/fake']))
  assert.equal(result.selected?.ref, 'claude-code/fake')
  assert.match(result.candidates.find((c) => c.ref === 'web/fake')!.reason, /^limited:/)
})
test('falls back when every preferred Account is over its ceiling', () => {
  const rows = accounts()
  rows[0]!.quota = async () => reading(95)
  const result = route(registry(rows), undefined, new Set(), 'research.web', new Map([['web/fake', reading(95)], ['claude-code/fake', reading(5)]]))
  assert.equal(result.selected?.ref, 'claude-code/fake')
  assert.equal(result.quotaWait, undefined)
})
test('no preference ranks as before and every candidate has a reason', () => {
  const capabilities = registry()
  const result = capabilities.routeWorker(['research'], undefined, undefined, new Map([['claude-code/fake', reading(5)]]))
  assert.equal(result.selected?.ref, 'claude-code/fake')
  assert.ok(result.candidates.every((c) => typeof c.reason === 'string' && c.reason.length > 0))
})

async function setup(t: TestContext, rows = accounts()) {
  const table = memoryWorkTable()
  const stored = new Set<string>()
  const specs = new Map<string, ResolvedSpec>()
  const specStore: SpecStore = {
    unchangedBase: () => undefined,
    kindOf: (id) => specs.has(id) ? 'workflow-spec' : stored.has(id) ? 'output' : undefined,
    putSpec: async (spec) => { const id = digest(JSON.stringify(spec)); specs.set(id, structuredClone(spec)); return id },
    getSpec: (id) => structuredClone(specs.get(id)),
    exists: (id) => stored.has(id) || specs.has(id),
    putVerdict: async () => { throw new Error('no verifier in preference tests') },
    taskOf: () => undefined,
    withNote: async () => { throw new Error('no Item in preference tests') },
  }
  const ran: string[] = []
  const capabilities = registry(rows.map((row) => ({
    ref: row.ref, get capabilities() { return row.capabilities }, quota: row.quota,
    async run() {
      ran.push(row.ref)
      if (row.run) return row.run()
      const output = digest(`${row.ref}:${ran.length}`)
      stored.add(output)
      return { status: 'succeeded', outputs: { result: output } }
    },
  })))
  const slots = new Slots(capabilities)
  const newController = () => new WorkController(table, specStore, capabilities, undefined, slots)
  let controller = newController()
  const spec = directTask(['research'], false, capabilities.available())
  Object.assign(spec.steps[0]!, { prefer: 'research.web', retry: { onFail: ['task'], max: 1 } })
  const { id } = await controller.admit({ spec, caller, source: { kind: 'direct-task' } })
  const runs: Promise<WorkRecord>[] = []
  t.after(async () => {
    const record = controller.get(id)
    if (record && !TERMINAL.has(record.state.status)) await controller.cancel(id, { caller, reason: 'test cleanup' })
    await Promise.allSettled(runs)
  })
  return {
    id, ran, record: () => controller.get(id)!,
    run: () => { const run = controller.run(id); runs.push(run); return run },
    get controller() { return controller },
    reopen() { controller = newController() },
  }
}

test('a Work whose step prefers the role runs on the web fake first', async (t) => {
  const f = await setup(t)
  const done = await f.run()
  assert.equal(done.state.status, 'succeeded')
  assert.equal(dispatched(done)[0]?.selected, 'web/fake')
  assert.deepEqual(f.ran, ['web/fake'])
})
test('an outside failure falls back to Claude', async (t) => {
  let ready = true
  const f = await setup(t, [
    { ref: 'web/fake', get capabilities() { return ready ? webCaps : [] }, run: async () => {
      ready = false
      return { status: 'failed', outputs: {}, reason: 'site error: the answer did not load' }
    } },
    // Initially over its ceiling: exercise observation/retry even before
    // preference routing is implemented. After the web failure it is usable.
    { ref: 'claude-code/fake', capabilities: ['research'], quota: async () => reading(ready ? 95 : 5) },
  ])
  const running = f.run()
  await turns()
  await eventually(() => f.record().events.some((e) => e.type === 'observed'), 'web failure must be observed')
  const observed = f.record().events.find((e) => e.type === 'observed')!
  assert.equal(dispatched(f.record())[0]?.selected, 'web/fake')
  assert.equal(observed.retryable, true)
  const done = await running
  const reopened = done.events.find((e) => e.type === 'reopened')
  assert.equal(reopened?.automatic, true)
  assert.ok(observed.seq < reopened!.seq && reopened!.seq < dispatched(done)[1]!.seq)
  assert.deepEqual(dispatched(done).map((e) => e.selected), ['web/fake', 'claude-code/fake'])
  assert.equal(done.state.status, 'succeeded')
})
test('a failure that leaves the Account ready is not retried', async (t) => {
  const f = await setup(t, [
    { ref: 'web/fake', capabilities: webCaps, run: async () => ({ status: 'failed', outputs: {}, reason: 'no output block' }) },
    { ref: 'claude-code/fake', capabilities: ['research'], quota: async () => reading(95) },
  ])
  const done = await f.run()
  assert.equal(done.state.status, 'failed')
  assert.deepEqual(f.ran, ['web/fake'])
  assert.equal(done.state.steps.task!.attempts.length, 1)
  assert.equal(done.events.some((e) => e.type === 'reopened'), false)
  assert.equal(done.events.find((e) => e.type === 'observed')?.retryable, undefined)
})
test('reopening and replaying a succeeded preferred Work use recorded reasons without rerouting', async (t) => {
  let calls = 0
  let used = 5
  const rows = accounts()
  rows[1]!.quota = async () => { calls++; return reading(used) }
  const f = await setup(t, rows)
  const done = await f.run()
  const decisions = dispatched(done)
  const before = calls
  used = 99
  f.reopen()
  assert.equal(f.controller.replay(f.id).matches, true)
  assert.deepEqual(dispatched(await f.run()), decisions)
  assert.equal(calls, before, 'replay and run of a terminal Work do not read quota')
  assert.deepEqual(f.ran, ['web/fake'])
  assert.equal(decisions[0]?.candidates.find((c) => c.ref === 'claude-code/fake')?.reason, 'capable; research.web Account preferred')
})
