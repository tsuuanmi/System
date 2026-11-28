/** Item sch-5: `system items carry --schedule <file> --check` starts nothing, is silent when all is well, and otherwise exits 1 with the notifier line. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NotRunning } from '@system/host'
import { buildProgram, type Run } from '../src/cli.ts'
import type { HostClient } from '../src/remote.ts'
import { fakeHost } from './fake-host.ts'

async function system(args: string[], host: HostClient) {
  let out = ''
  let err = ''
  let run: Run | undefined
  const io = { out: (t: string) => { out += t }, err: (t: string) => { err += t }, confirmHuman: async () => 'tan' } as any
  const program = buildProgram(host, io, (r) => { run = r }, '/nonexistent-home')
  program.exitOverride()
  await program.parseAsync(['node', 'system', ...args])
  return { code: await run!(), out, err }
}

const NOW = Date.parse('2026-11-28T00:00:00.000Z')
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString()
const account = (ref: string, extra: Record<string, unknown> = {}) => ({ ref, runtime: 'claude', available: true, reason: 'ready', ...extra })

/** A Host that answers `workers.list` with `view`, and fails the test on anything that would start something. */
function hostOf(view: (p: any) => unknown, calls: string[] = []) {
  return fakeHost({ 'workers.list': (p: any) => { calls.push('workers.list'); return view(p) } })
}
const view = (over: { ready?: unknown[]; room?: Record<string, unknown>; accounts?: unknown[] } = {}) => () => ({
  registered: ['claude/a'],
  accounts: over.accounts ?? [account('claude/a')],
  room: { accounts: 1, free: 1, unknown: [], ready: over.ready ?? [{ repository: '/w/A', count: 2 }], ...over.room },
})

async function check(host: HostClient, schedule = 'kind: items\nrepositories: [/w/A]\nat: daily\n') {
  const dir = mkdtempSync(join(tmpdir(), 'system-check-test-'))
  const marker = join(dir, 'notified')
  const saved = process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND
  process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND = `printf '%s\\n' "$1" >> ${marker}`
  try {
    const file = join(dir, 'daily.yaml')
    writeFileSync(file, schedule)
    const result = await system(['items', 'carry', '--schedule', file, '--check'], host)
    let notified = ''
    try { notified = (await import('node:fs')).readFileSync(marker, 'utf8') } catch { /* none sent */ }
    return { ...result, notified }
  } finally {
    if (saved === undefined) delete process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND
    else process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND = saved
    rmSync(dir, { recursive: true, force: true })
  }
}

test('sch-5: all well is silent, exits 0, sends nothing and starts nothing', async () => {
  const calls: string[] = []
  const r = await check(hostOf(view({ accounts: [account('claude/a', { credentialExpiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString() })] }), calls))
  assert.deepEqual({ code: r.code, out: r.out, err: r.err, notified: r.notified }, { code: 0, out: '', err: '', notified: '' })
  assert.deepEqual(calls, ['workers.list'])
})

test('sch-5: no Ready Item is not a problem', async () => {
  const r = await check(hostOf(view({ ready: [{ repository: '/w/A', count: 0 }], room: { free: 0 } })))
  assert.deepEqual({ code: r.code, out: r.out, err: r.err, notified: r.notified }, { code: 0, out: '', err: '', notified: '' })
})

test('sch-5: a Host that does not answer exits 1 and notifies', async () => {
  const r = await check(fakeHost({ 'workers.list': async () => { throw new NotRunning('/h') } }))
  assert.equal(r.code, 1)
  assert.match(r.err, /Host/i)
  assert.match(r.notified, /A: check failed: .*Host/i)
})

test('sch-5: a repository whose status cannot be read exits 1 and names it', async () => {
  const r = await check(hostOf(view({ ready: [{ repository: '/w/A', error: 'no STATUS.md' }] })))
  assert.equal(r.code, 1)
  assert.match(r.err, /\/w\/A: status cannot be read: no STATUS\.md/)
  assert.match(r.notified, /status cannot be read: no STATUS\.md/)
})

test('sch-5: Ready Items and no free Account exits 1', async () => {
  const r = await check(hostOf(view({ room: { free: 0 } })))
  assert.equal(r.code, 1)
  assert.match(r.err, /2 Ready Items.*no free Account \(0 of 1 free\)/)
  assert.match(r.notified, /2 Ready Items/)
})

test('sch-5: a signed-out Account exits 1 when Items are Ready, and names it', async () => {
  const r = await check(hostOf(view({ accounts: [account('claude/a'), account('claude/b', { available: false, reason: 'signed out' })] })))
  assert.equal(r.code, 1)
  assert.match(r.err, /claude\/b is not available: signed out/)
  assert.match(r.notified, /claude\/b is not available: signed out/)
})

test('sch-5: a sign-in the Runtime says ends within 3 days exits 1; later does not', async () => {
  const soon = await check(hostOf(view({ accounts: [account('claude/a', { credentialExpiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() })] })))
  assert.equal(soon.code, 1)
  assert.match(soon.err, /claude\/a: sign-in ends 20\d\d-\d\d-\d\dT/)
  const gone = await check(hostOf(view({ accounts: [account('claude/a', { credentialExpiresAt: new Date(Date.now() - 1000).toISOString() })] })))
  assert.equal(gone.code, 1)
})

test('sch-5: --check without --schedule is refused', async () => {
  await assert.rejects(system(['items', 'carry', '--check', '--repo', '/w/A'], hostOf(view())), /--check goes with --schedule/)
})
