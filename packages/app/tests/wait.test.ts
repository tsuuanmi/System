import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Client } from '../../host/lib/index.js'
import { buildProgram, type ClientHost, type Run, type WaitOptions, type Waited } from '../src/cli.ts'
import { remoteHost } from '../src/remote.ts'

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

test('work wait without --any exits with the code of the Work that decided it, one line per Work', async () => {
  const result = await wait(['work:a', 'work:b'], { records: [record('work:a', 'failed', { reason: 'x' }), record('work:b', 'succeeded')], decided: 'work:b', timedOut: false })
  assert.equal(result.code, 0)
  assert.equal(result.out, 'work:a  failed  x\nwork:b  succeeded\n')
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

test('work wait refuses a timeout that is not a positive number', async () => {
  const bad = await wait(['work:a', '--timeout', 'soon'], { records: [], timedOut: false }).catch((e: Error) => e)
  assert.ok(bad instanceof Error)
  assert.match(bad.message, /--timeout/)
})

/** A Host whose `work.events`/`work.show` answer from `status`. */
function fakeRemote(status: Record<string, string>, opened: { readOnly: (boolean | undefined)[] } = { readOnly: [] }) {
  const open = async (_caller: unknown, options?: { readOnly?: boolean }): Promise<Client> => {
    opened.readOnly.push(options?.readOnly)
    return {
      call: async (method: string, params: any) => method === 'work.events'
        ? { events: [], status: status[params.workId] }
        : { id: params.workId, state: { status: status[params.workId], reason: 'r' } },
      onNotice: () => {}, close: () => {},
    } as Client
  }
  return remoteHost({ open: open as any, err: () => {} }).work()
}

test('waitFor returns once every Work has ended, and the last to end decided', { timeout: 20_000 }, async () => {
  const waited = await fakeRemote({ 'work:a': 'succeeded', 'work:b': 'held' }).waitFor(['work:a', 'work:b'], { any: false })
  assert.equal(waited.timedOut, false)
  assert.deepEqual(waited.records.map((r) => r.state.status), ['succeeded', 'held'])
  assert.ok(['work:a', 'work:b'].includes(waited.decided!))
})

test('waitFor --any returns at the first Work that ended while the other still runs', { timeout: 20_000 }, async () => {
  const waited = await fakeRemote({ 'work:a': 'running', 'work:b': 'held' }).waitFor(['work:a', 'work:b'], { any: true })
  assert.equal(waited.decided, 'work:b')
  assert.deepEqual(waited.records.map((r) => r.state.status), ['running', 'held'])
})

test('waitFor gives up at the timeout with timedOut set and the Works as they are', { timeout: 20_000 }, async () => {
  const started = Date.now()
  const waited = await fakeRemote({ 'work:a': 'running' }).waitFor(['work:a'], { any: false, timeoutMs: 100 })
  assert.equal(waited.timedOut, true)
  assert.equal(waited.decided, undefined)
  assert.equal(waited.records[0]!.state.status, 'running')
  assert.ok(Date.now() - started < 5000)
})
