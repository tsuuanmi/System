import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Client } from '../../host/lib/index.js'
import { buildProgram, type ClientHost, type Run, type WaitOptions, type Waited } from '../src/cli.ts'
import { remoteHost } from '../src/remote.ts'
import { NotAnswering, NotRunning } from '../../host/lib/index.js'

const record = (id: string, status: string, extra: object = {}) => ({ id, events: [], state: { status, ...extra } }) as any

/** Run `system work wait ...args` against a fake `waitFor`; returns the exit code and what was printed. */
async function wait(args: string[], waited: Waited | ((ids: string[], options: WaitOptions) => Waited)) {
  let seen: { ids: string[]; options: WaitOptions } | undefined
  const host = { work: () => ({ waitFor: async (ids: string[], options: WaitOptions) => { seen = { ids, options }; return typeof waited === 'function' ? waited(ids, options) : waited } }) } as unknown as ClientHost
  let out = ''
  let err = ''
  let run: Run | undefined
  const program = buildProgram(host, { out: (t: string) => { out += t }, err: (t: string) => { err += t } } as any, (r) => { run = r })
  program.exitOverride()
  await program.parseAsync(['node', 'system', 'work', 'wait', ...args])
  const code = await run!()
  return { code, out, err, seen: seen! }
}

for (const [status, code] of [['succeeded', 0], ['failed', 1], ['held', 3], ['cancelled', 5]] as const) {
  test(`work wait exits ${code} when the Work is ${status}, and prints its ID, status and reason`, async () => {
    const result = await wait(['work:a'], { records: [record('work:a', status, { reason: 'because' })], decided: 'work:a', timedOut: false })
    assert.equal(result.code, code)
    assert.equal(result.out, `work:a  ${status}  because\n`)
    assert.deepEqual(result.seen.ids, ['work:a'])
    assert.deepEqual(result.seen.options, { any: false, timeoutMs: undefined })
  })
}

test('work wait says what a held Work awaits when it has no reason', async () => {
  const result = await wait(['work:a'], { records: [record('work:a', 'held', { awaiting: 'ship' })], decided: 'work:a', timedOut: false })
  assert.equal(result.out, 'work:a  held  awaiting ship\n')
  assert.equal(result.code, 3)
})

test('work wait without --any exits with the worst outcome among the Works', async () => {
  const result = await wait(['work:a', 'work:b'], { records: [record('work:a', 'failed', { reason: 'x' }), record('work:b', 'succeeded')], decided: 'work:b', timedOut: false })
  assert.equal(result.code, 1)
  assert.equal(result.out, 'work:a  failed  x\nwork:b  succeeded\n')
})

for (const [a, b, code] of [['held', 'succeeded', 3], ['succeeded', 'held', 3], ['failed', 'held', 1], ['held', 'cancelled', 5], ['failed', 'cancelled', 1]] as const) {
  test(`work wait without --any on ${a} and ${b} exits ${code}`, async () => {
    const result = await wait(['work:a', 'work:b'], { records: [record('work:a', a), record('work:b', b)], decided: 'work:b', timedOut: false })
    assert.equal(result.code, code)
  })
}

test('work wait --any still exits with the code of the Work that decided it, not the worst', async () => {
  const result = await wait(['work:a', 'work:b', '--any'], { records: [record('work:a', 'failed'), record('work:b', 'held')], decided: 'work:b', timedOut: false })
  assert.equal(result.code, 3)
})

test('work wait --any passes the flag and exits with the code of the first Work to end; the others print as they are', async () => {
  const result = await wait(['work:a', 'work:b', '--any'], { records: [record('work:a', 'running'), record('work:b', 'held', { reason: 'r' })], decided: 'work:b', timedOut: false })
  assert.equal(result.seen.options.any, true)
  assert.equal(result.code, 3)
  assert.equal(result.out, 'work:a  running\nwork:b  held  r\n')
})

test('work wait --timeout passes minutes as milliseconds and exits 4 saying it timed out', async () => {
  const result = await wait(['work:a', '--timeout', '2'], { records: [record('work:a', 'running')], timedOut: true })
  assert.equal(result.seen.options.timeoutMs, 120_000)
  assert.equal(result.code, 4)
  assert.equal(result.out, 'work:a  running\n')
  assert.match(result.err, /timed out after 2 minutes/)
})

test('work wait exits 6 when the Host stayed unreachable, never 0', async () => {
  const waited = { records: [], timedOut: false, unreachable: 'x' }
  const result = await wait(['work:a'], waited)
  assert.equal(result.code, 6)
  assert.match(result.err, /did not answer/)
  assert.match(result.err, /exit 6/)
})

test('work wait refuses a timeout that is not a positive number', async () => {
  const bad = await wait(['work:a', '--timeout', 'soon'], { records: [], timedOut: false }).catch((e: Error) => e)
  assert.ok(bad instanceof Error)
  assert.match(bad.message, /--timeout/)
})

/** A Host whose `work.events`/`work.show` answer from `status`. */
function fakeRemote(status: Record<string, string>, opened: { readOnly: (boolean | undefined)[] } = { readOnly: [] }, down = 0, options: { late?: number; never?: boolean; lateFinalShow?: number; reconnectMs?: number; calls?: string[] } = {}) {
  let late = options.late ?? 0
  let shows = 0
  const open = async (_caller: unknown, connectionOptions?: { readOnly?: boolean }): Promise<Client> => {
    opened.readOnly.push(connectionOptions?.readOnly)
    if (down-- > 0) throw new NotRunning('the System Host is not running')
    return {
      call: async (method: string, params: any) => {
        options.calls?.push(method)
        if (method === 'work.show') shows++
        if (options.never || late-- > 0 || (method === 'work.show' && shows > 1 && shows <= 1 + (options.lateFinalShow ?? 0))) {
          throw new NotAnswering(`the Host is not answering ${method} after 10000 ms`)
        }
        return method === 'work.events'
          ? { events: [], status: status[params.workId] }
          : { id: params.workId, state: { status: status[params.workId], reason: 'r' } }
      },
      onNotice: () => {}, close: () => {},
    } as Client
  }
  const remote = { open: open as any, err: () => {}, retryMs: 5, reconnectMs: options.reconnectMs }
  return remoteHost(remote).work()
}

// These structural types keep the tests compilable before Waited gains the field.
const unreachable = (waited: Waited): unknown => 'unreachable' in waited ? waited.unreachable : undefined

test('waitFor keeps waiting when the Host answers late a few times, then normally', async () => {
  await assert.doesNotReject(async () => {
    const waited = await fakeRemote({ 'work:a': 'succeeded' }, undefined, 0, { late: 3, reconnectMs: 60_000 }).waitFor(['work:a'], { any: false })
    assert.equal(waited.decided, 'work:a')
    assert.equal(waited.records[0]!.state.status, 'succeeded')
    assert.equal(unreachable(waited), undefined)
    assert.equal(waited.timedOut, false)
  })
})

test('waitFor retries the final work.show read too', async () => {
  const calls: string[] = []
  await assert.doesNotReject(async () => {
    // follow's first show succeeds; only waitFor's final read fails twice.
    const waited = await fakeRemote({ 'work:a': 'succeeded' }, undefined, 0, { lateFinalShow: 2, calls, reconnectMs: 60_000 }).waitFor(['work:a'], { any: false })
    assert.equal(waited.decided, 'work:a')
    assert.equal(waited.records[0]!.state.status, 'succeeded')
    assert.equal(waited.timedOut, false)
    assert.equal(unreachable(waited), undefined)
    assert.deepEqual(calls, ['work.events', 'work.show', 'work.show', 'work.show', 'work.show'])
  })
})

test('waitFor ends with unreachable when the Host never answers', async () => {
  const started = Date.now()
  await assert.doesNotReject(async () => {
    const waited = await fakeRemote({}, undefined, 0, { never: true, reconnectMs: 300 }).waitFor(['work:a'], { any: false })
    assert.ok(unreachable(waited))
    assert.equal(waited.timedOut, false)
    assert.ok(Date.now() - started >= 300, 'wait for the outage bound before giving up')
    assert.ok(Date.now() - started < 5000, 'the test outage bound is milliseconds, not minutes')
  })
})

test("waitFor's --timeout ends an outage as unreachable, not as a timeout", async () => {
  const started = Date.now()
  await assert.doesNotReject(async () => {
    const waited = await fakeRemote({}, undefined, 0, { never: true, reconnectMs: 60_000 }).waitFor(['work:a'], { any: false, timeoutMs: 200 })
    assert.ok(unreachable(waited))
    assert.equal(waited.timedOut, false)
    assert.ok(Date.now() - started >= 200, 'the timeout bounds the outage')
    assert.ok(Date.now() - started < 5000, 'the timeout interrupts outage retries')
  })
})

test('non-patient reads still fail at once', async () => {
  for (const method of ['wait', 'get'] as const) {
    const calls: string[] = []
    const work = fakeRemote({}, undefined, 0, { never: true, calls })
    await assert.rejects(async () => work[method]('work:a'), NotAnswering)
    assert.deepEqual(calls, [method === 'wait' ? 'work.events' : 'work.show'], 'no retry for a non-patient read')
  }
})

test('waitFor returns once every Work has ended, and the last to end decided', { timeout: 120_000 }, async () => {
  const waited = await fakeRemote({ 'work:a': 'succeeded', 'work:b': 'held' }).waitFor(['work:a', 'work:b'], { any: false })
  assert.equal(waited.timedOut, false)
  assert.deepEqual(waited.records.map((r) => r.state.status), ['succeeded', 'held'])
  assert.ok(['work:a', 'work:b'].includes(waited.decided!))
})

test('waitFor --any returns at the first Work that ended while the other still runs', { timeout: 120_000 }, async () => {
  const waited = await fakeRemote({ 'work:a': 'running', 'work:b': 'held' }).waitFor(['work:a', 'work:b'], { any: true })
  assert.equal(waited.decided, 'work:b')
  assert.deepEqual(waited.records.map((r) => r.state.status), ['running', 'held'])
})

test('waitFor gives up at the timeout with timedOut set and the Works as they are', { timeout: 120_000 }, async () => {
  const started = Date.now()
  const waited = await fakeRemote({ 'work:a': 'running' }).waitFor(['work:a'], { any: false, timeoutMs: 100 })
  assert.equal(waited.timedOut, true)
  assert.equal(waited.decided, undefined)
  assert.equal(waited.records[0]!.state.status, 'running')
  assert.ok(Date.now() - started < 60_000)
})

test('waitFor reconnects after repeated Host startup failures', { timeout: 120_000 }, async () => {
  const waited = await fakeRemote({ 'work:a': 'succeeded' }, { readOnly: [] }, 4).waitFor(['work:a'], { any: false })
  assert.equal(waited.decided, 'work:a')
  assert.equal(waited.records[0]!.state.status, 'succeeded')
})
