import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { memoryWorkTable } from '../../../test-support/memory.ts'
import type { QuotaReport } from '../../agents/src/quota.ts'
import { WorkController, type SpecStore } from '../src/controller.ts'
import { Slots } from '../src/slots.ts'
import { fold, TERMINAL, type WorkRecord } from '../src/record.ts'
import { Capabilities, type WorkerPort, type WorkerRequest, type WorkerResult } from '../src/registry.ts'
import { directTask, type ResolvedSpec } from '../src/workflow.ts'

const caller = { type: 'human', operatorId: 'quota-test' } as const
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const reading = (five: number, seven?: number, resetsAt?: string): QuotaReport => ({ observedAt: '2026-11-10T00:00:00Z', windows: { five_hour: { percentUsed: five, resetsAt }, ...(seven === undefined ? {} : { seven_day: { percentUsed: seven, resetsAt } }) } })
// These structural additions are the Worker port contract in the SC plan.
// They compile on the old port too, without changing production code.
type Account = Pick<WorkerPort, 'ref'> & { priority?: 'primary' | 'secondary'; quota?: (fresh?: boolean) => Promise<QuotaReport>; run?: (request: WorkerRequest) => Promise<WorkerResult | undefined> }
const turns = async () => { for (let n = 0; n < 30; n++) await new Promise<void>((resolve) => setImmediate(resolve)) }
async function eventually(condition: () => boolean, message: string) {
  for (const end = Date.now() + 60_000; !condition() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(condition(), message)
}
const dispatched = (record: WorkRecord) => record.events.filter((e) => e.type === 'dispatched')

async function setup(t: TestContext, accounts: Account[], pinned?: string, retry = false) {
  const table = memoryWorkTable()
  const capabilities = new Capabilities()
  const stored = new Set<string>()
  const specs = new Map<string, ResolvedSpec>()
  const specStore: SpecStore = {
    unchangedBase: () => undefined,
    kindOf: (id) => specs.has(id) ? 'workflow-spec' : stored.has(id) ? 'output' : undefined,
    putSpec: async (spec) => { const id = digest(JSON.stringify(spec)); specs.set(id, structuredClone(spec)); return id },
    getSpec: (id) => structuredClone(specs.get(id)),
    exists: (id) => stored.has(id) || specs.has(id),
    putVerdict: async () => { throw new Error('no verifier in quota routing tests') },
    taskOf: () => undefined,
    withNote: async () => { throw new Error('no Item in quota routing tests') },
  }
  const ran: { worker: string; request: WorkerRequest }[] = []
  for (const account of accounts) capabilities.registerWorker({
    ...account, capabilities: ['research'],
    async run(request) {
      ran.push({ worker: account.ref, request })
      const result = await account.run?.(request)
      if (result) return result
      const output = digest(request.attemptId)
      stored.add(output)
      return { status: 'succeeded', outputs: { result: output } }
    },
  })
  const slots = new Slots(capabilities)
  // The plan adds a trailing quotaRetryMs constructor argument. Reflect keeps
  // this test seam compilable before that argument exists in production.
  const newController = (): WorkController => Reflect.construct(WorkController, [table, specStore, capabilities, undefined, slots, undefined, undefined, 20])
  let controller = newController()
  const spec = directTask(['research'], false, capabilities.available())
  if (retry) Object.assign(spec.steps[0]!, { retry: { onFail: ['task'], max: 1 } })
  const { id } = await controller.admit({ spec, caller, source: { kind: 'direct-task' }, ...(pinned ? { worker: pinned } : {}) })
  const runs: Promise<WorkRecord>[] = []
  t.after(async () => {
    // cancel rejects for terminal Works; cleanup must preserve the test's
    // assertion failure instead of introducing a hook failure.
    const record = controller.get(id)
    if (record && !TERMINAL.has(record.state.status)) await controller.cancel(id, { caller, reason: 'test cleanup' })
    await Promise.allSettled(runs)
  })
  return {
    id, ran, capabilities, table, slots,
    get controller() { return controller },
    record: () => controller.get(id)!,
    run: () => { const run = controller.run(id); runs.push(run); return run },
    reopen() { controller = newController(); return controller },
  }
}

test('dispatch chooses the headroom Account and records every candidate reading', async (t) => {
  const f = await setup(t, [
    { ref: 'P', priority: 'primary', quota: async () => reading(91, 31) },
    { ref: 'S', quota: async () => reading(40) },
  ])
  const done = await f.run()
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(f.ran.map((r) => r.worker), ['S'])
  const [event] = dispatched(done)
  assert.equal(event?.selected, 'S')
  assert.equal(event?.candidates.find((c) => c.ref === 'P')?.reason, 'over 80% (5h 91%)')
  assert.match(event!.candidates.find((c) => c.ref === 'S')!.reason, /^headroom 60%(?: \(|$)/)
})
test('dispatch prefers a primary under the ceiling over greater secondary headroom', async (t) => {
  const f = await setup(t, [
    { ref: 'S', quota: async () => reading(10) },
    { ref: 'P', priority: 'primary', quota: async () => reading(43, 31) },
  ])
  const [event] = dispatched(await f.run())
  assert.equal(event?.selected, 'P')
  assert.equal(event?.candidates.find((c) => c.ref === 'P')?.reason, 'primary under 80% (5h 43%, 7d 31%)')
})
for (const throws of [false, true]) {
  test(`unreadable quota stays usable (${throws ? 'reader throws' : 'unknown version'})`, async (t) => {
    const f = await setup(t, [{ ref: 'P', quota: async () => {
      if (throws) throw new Error('unknown version')
      return { unreadable: 'unknown version' }
    } }])
    const done = await f.run()
    assert.equal(done.state.status, 'succeeded')
    assert.equal(dispatched(done)[0]?.selected, 'P')
    assert.match(dispatched(done)[0]!.candidates[0]!.reason, /quota unreadable: .*unknown version/)
  })
}
for (const resetKnown of [true, false]) {
  test(`quota wait spends no attempt and starts after a reading drops (${resetKnown ? 'earliest reset known' : 'no reset: periodic retry'})`, async (t) => {
    const earliest = resetKnown ? new Date(Date.now() + 60_000).toISOString() : undefined
    const later = resetKnown ? new Date(Date.now() + 120_000).toISOString() : undefined
    let used = 91
    const f = await setup(t, [
      { ref: 'P', priority: 'primary', quota: async () => reading(used, 31, later) },
      { ref: 'S', quota: async () => reading(90, undefined, earliest) },
    ])
    const running = f.run()
    await turns()
    assert.deepEqual(dispatched(f.record()), [], 'waiting must not dispatch or spend an attempt')
    assert.equal(f.ran.length, 0)
    assert.deepEqual(f.record().state.steps.task!.attempts, [])
    const waiting = f.controller.live(f.id).find((entry) => String(entry.waiting) === 'quota')
    assert.ok(waiting, 'live view shows waiting: quota')
    assert.equal(Reflect.get(waiting, 'until'), earliest)
    for (const ref of ['P', 'S']) assert.equal(f.slots.hasFree(f.capabilities.workerFor(ref)!), true)
    used = 30
    await eventually(() => TERMINAL.has(f.record().state.status), 'a changed reading wakes the quota wait without a freed slot')
    const done = await running
    assert.equal(done.state.status, 'succeeded')
    assert.equal(dispatched(done).length, 1)
    assert.equal(done.state.steps.task!.attempts.length, 1)
    assert.deepEqual(f.ran.map((r) => r.worker), ['P'])
    assert.deepEqual(f.controller.live(f.id), [])
  })
}
test('a pinned over-ceiling Account waits rather than failing or falling back', async (t) => {
  const f = await setup(t, [
    { ref: 'P', quota: async () => reading(91) },
    { ref: 'S', quota: async () => reading(10) },
  ], 'P')
  f.run()
  await turns()
  assert.deepEqual(dispatched(f.record()), [])
  assert.equal(f.record().state.status, 'running')
  assert.equal(String(f.controller.live(f.id)[0]?.waiting), 'quota')
})
test('reopening and replaying a succeeded Work use recorded reasons without calling quota', async (t) => {
  let calls = 0
  let used = 43
  const f = await setup(t, [{ ref: 'P', priority: 'primary', quota: async () => { calls++; return reading(used, 31) } }])
  const done = await f.run()
  assert.ok(calls > 0, 'dispatch must obtain a quota reading')
  const before = calls
  const decisions = dispatched(done)
  assert.equal(decisions[0]?.candidates[0]?.reason, 'primary under 80% (5h 43%, 7d 31%)')
  used = 99
  await f.reopen()
  assert.equal(f.controller.replay(f.id).matches, true)
  assert.deepEqual(dispatched(f.record()), decisions)
  assert.equal(calls, before, 'replay must not re-read changed quota')
})
test('recovery marks a recorded dispatched attempt lost without re-routing or reading quota', async (t) => {
  let calls = 0
  const f = await setup(t, [{ ref: 'P', quota: async () => { calls++; return reading(40) } }])
  const done = await f.run()
  assert.ok(calls > 0, 'dispatch must obtain a quota reading')
  const before = calls
  // Simulate a durable crash boundary: only admitted/dispatched persisted.
  const event = dispatched(done)[0]!
  const events = done.events.slice(0, event.seq + 1)
  f.table.rows.set(f.id, { ...done, events, state: fold(['task'], events) })
  f.reopen()
  await f.controller.interrupt(f.id)
  assert.equal(f.record().events.at(-1)?.type, 'attempt-lost')
  assert.deepEqual(dispatched(f.record()), [event])
  assert.equal(f.controller.replay(f.id).matches, true)
  assert.equal(calls, before)
})
test('cancelling a quota wait ends the Work and clears the live entry and retry', async (t) => {
  let calls = 0
  const f = await setup(t, [{ ref: 'P', quota: async () => { calls++; return reading(91) } }])
  const running = f.run()
  await turns()
  assert.equal(String(f.controller.live(f.id)[0]?.waiting), 'quota')
  await f.controller.cancel(f.id, { caller, reason: 'stop quota wait' })
  assert.equal((await running).state.status, 'cancelled')
  assert.deepEqual(f.controller.live(f.id), [])
  assert.deepEqual(f.ran, [])
  const before = calls
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(calls, before, 'cancelled waits leave no retry that reads quota')
})

const outOfCredits = 'codex/default exit 1: Your workspace is out of credits. Add credits to continue.'
const observations = (record: WorkRecord) => record.events.filter((event) => event.type === 'observed')

test('a limited attempt moves the step to the other Account and the Work succeeds', async (t) => {
  let limited = false
  const f = await setup(t, [
    { ref: 'P', priority: 'primary', quota: async () => reading(limited ? 100 : 30), run: async () => {
      if (!limited) { limited = true; return { status: 'failed', outputs: {}, reason: outOfCredits } }
    } },
    { ref: 'S', quota: async () => reading(10) },
  ])
  const done = await f.run()
  assert.equal(done.state.status, 'succeeded')
  const events = done.events.filter((event) => event.type === 'dispatched' || event.type === 'observed')
  assert.deepEqual(events.map((event) => event.type === 'dispatched'
    ? ['dispatched', event.selected]
    : ['observed', event.status, Reflect.get(event, 'limited')]), [
    ['dispatched', 'P'], ['observed', 'failed', true], ['dispatched', 'S'], ['observed', 'succeeded', undefined],
  ])
  assert.equal(observations(done)[0]?.reason, outOfCredits)
  assert.deepEqual(f.ran.map((r) => r.worker), ['P', 'S'])
  assert.equal(done.state.steps.task!.state, 'succeeded')
  assert.equal(done.state.steps.task!.attempts.length, 2, 'both attempts remain in the record')
  assert.equal(dispatched(done)[1]?.candidates.find((c) => c.ref === 'P')?.selected, false)
})

test('with one Account a limited step waits on quota', async (t) => {
  let used = 30
  let first = true
  const f = await setup(t, [{ ref: 'P', quota: async () => reading(used), run: async () => {
    if (first) { first = false; used = 100; return { status: 'failed', outputs: {}, reason: outOfCredits } }
  } }])
  const running = f.run()
  await eventually(() => f.controller.live(f.id).some((entry) => String(entry.waiting) === 'quota'), 'limited step must wait on quota')
  assert.equal(TERMINAL.has(f.record().state.status), false)
  assert.equal(f.record().state.steps.task!.state, 'pending')
  assert.equal(dispatched(f.record()).length, 1)
  assert.equal(observations(f.record()).length, 1)
  assert.equal(Reflect.get(observations(f.record())[0]!, 'limited'), true)
  used = 10
  await eventually(() => TERMINAL.has(f.record().state.status), 'quota retry must wake the pending step')
  assert.equal((await running).state.status, 'succeeded')
  assert.deepEqual(dispatched(f.record()).map((event) => event.selected), ['P', 'P'])
})

test('a limited attempt drops the cached quota reading', async (t) => {
  let attempted = false
  let cached = reading(30)
  const calls: { ref: string; fresh?: boolean; attempted: boolean }[] = []
  const f = await setup(t, [
    { ref: 'P', priority: 'primary', quota: async (fresh) => {
      calls.push({ ref: 'P', fresh, attempted })
      if (fresh) cached = reading(100)
      return cached
    }, run: async () => { attempted = true; return { status: 'failed', outputs: {}, reason: outOfCredits } } },
    { ref: 'S', quota: async (fresh) => { calls.push({ ref: 'S', fresh, attempted }); return reading(10) } },
  ])
  // Inspect after observation even if a broken controller keeps routing to P.
  f.run()
  await eventually(() => observations(f.record()).length > 0, 'the first attempt must be observed')
  assert.equal(calls.filter((call) => call.ref === 'P' && call.fresh === true && call.attempted).length, 1)
  assert.equal(calls.some((call) => call.ref === 'S' && call.fresh === true), false)
  await eventually(() => TERMINAL.has(f.record().state.status), 'fresh quota routes to S')
  assert.equal(f.record().state.status, 'succeeded')
})

test('a limited attempt spends no retry', async (t) => {
  for (const genuineFailure of [false, true]) {
    let limited = false
    let failed = false
    const f = await setup(t, [
      { ref: 'P', priority: 'primary', quota: async () => reading(limited ? 100 : 30), run: async () => {
        limited = true
        return { status: 'failed', outputs: {}, reason: outOfCredits }
      } },
      { ref: 'S', quota: async () => reading(10), run: async () => {
        if (genuineFailure && !failed) { failed = true; return { status: 'failed', outputs: {}, reason: 'temporary failure before sending', retryable: true } }
      } },
    ], undefined, true)
    const done = await f.run()
    assert.equal(done.state.status, 'succeeded', `genuine failure: ${genuineFailure}`)
    const reopens = done.events.filter((event) => event.type === 'reopened')
    assert.equal(reopens.length, genuineFailure ? 1 : 0)
    assert.ok(reopens.every((event) => event.automatic === true))
    assert.equal(observations(done).filter((event) => Reflect.get(event, 'limited') === true).length, 1)
    assert.deepEqual(f.ran.map((r) => r.worker), genuineFailure ? ['P', 'S', 'S'] : ['P', 'S'])
  }
})

test('replaying a Work with a limited attempt reads the record, not the provider', async (t) => {
  let limited = false
  let calls = 0
  const f = await setup(t, [
    { ref: 'P', priority: 'primary', quota: async () => { calls++; return reading(limited ? 100 : 30) }, run: async () => {
      limited = true
      return { status: 'failed', outputs: {}, reason: outOfCredits }
    } },
    { ref: 'S', quota: async () => { calls++; return reading(10) } },
  ])
  const done = await f.run()
  assert.equal(done.state.status, 'succeeded')
  assert.equal(Reflect.get(observations(done)[0]!, 'limited'), true)
  const before = calls
  f.reopen()
  assert.equal(f.controller.replay(f.id).matches, true)
  assert.deepEqual(f.record().state.steps, done.state.steps)
  assert.deepEqual(fold(['task'], f.record().events), done.state)
  assert.deepEqual(f.record().events, done.events)
  assert.equal(calls, before)
})
