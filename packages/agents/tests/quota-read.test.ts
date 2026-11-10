/** Reader protocols exercised only through private test-support CLIs and synthetic homes. */
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../../../test-support/accounts.ts'
import { until } from '../../../test-support/memory.ts'
import { claudeUsage, codexRateLimits, fakeQuotaCli, object } from '../../../test-support/quota.ts'
import { readClaudeQuota, readCodexQuota } from '../src/quota.ts'

const OBS = Date.parse('2026-11-10T12:00:00.000Z')
const RESET = '2026-11-10T14:00:00.000Z'
function unreadable(value: unknown, reason?: RegExp) {
  const report = object(value)
  assert.deepEqual(Object.keys(report), ['unreadable'])
  assert.ok(typeof report.unreadable === 'string' && report.unreadable.length > 0)
  if (reason) assert.match(report.unreadable, reason)
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) { return object(error).code === 'ESRCH' }
}

test('Claude quota uses one get_usage control request, the account HOME/token, and a minimal environment', async (t) => {
  const dir = tempDir('quota-read-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = fakeQuotaCli(join(dir, 'cli'), { kind: 'claude', version: '2.1.322', answer: claudeUsage({ five_hour: { utilization: 42, resets_at: RESET } }) })
  const previous = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'must-not-leak'
  try {
    const report = await readClaudeQuota({ command: fake.command, home: dir, token: 'tok-1', now: () => OBS })
    assert.deepEqual(report, { observedAt: new Date(OBS).toISOString(), windows: { five_hour: { percentUsed: 42, resetsAt: RESET } } })
    const entries = fake.readLog()
    assert.deepEqual(entries[0]?.argv, ['--version'])
    const launch = entries.find((entry) => entry.home !== undefined)
    assert.ok(launch)
    assert.equal(launch.home, dir)
    assert.equal(launch.token, 'tok-1')
    const argv = launch.argv
    assert.ok(Array.isArray(argv))
    for (const flag of ['-p', '--verbose', '--no-session-persistence', '--strict-mcp-config']) assert.ok(argv.includes(flag), flag)
    for (const flag of ['--input-format', '--output-format']) assert.equal(argv[argv.indexOf(flag) + 1], 'stream-json')
    assert.equal(argv.includes('--model'), false)
    const keys = launch.envKeys
    assert.ok(Array.isArray(keys))
    assert.ok(keys.every((key: unknown) => typeof key === 'string' && ['HOME', 'TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'PATH', 'LANG', 'LC_ALL', 'TZ'].includes(key)))
    const stdin = entries.filter((entry) => entry.stdin !== undefined).map((entry) => object(entry.stdin))
    assert.equal(stdin.length, 1, 'no model/user message')
    const message = stdin[0]!
    assert.equal(message.type, 'control_request')
    assert.equal(typeof message.request_id, 'string')
    assert.deepEqual(message.request, { subtype: 'get_usage', skip_behaviors: true })
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previous
  }
})
test('Codex initializes then reads rateLimits in the account CODEX_HOME', async (t) => {
  const dir = tempDir('quota-read-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = fakeQuotaCli(join(dir, 'cli'), { kind: 'codex', version: '0.166.0', answer: codexRateLimits({ primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: Date.parse(RESET) / 1000 } }) })
  assert.deepEqual(await readCodexQuota({ command: fake.command, codexHome: dir, now: () => OBS }), { observedAt: new Date(OBS).toISOString(), windows: { five_hour: { percentUsed: 42, resetsAt: RESET } } })
  const entries = fake.readLog()
  const launch = entries.find((entry) => entry.home !== undefined)
  assert.ok(launch)
  assert.deepEqual(launch.argv, ['app-server'])
  assert.equal(launch.home, dir)
  assert.equal(launch.codexHome, dir)
  const messages = entries.filter((entry) => entry.stdin !== undefined).map((entry) => object(entry.stdin))
  assert.deepEqual(messages, [
    { method: 'initialize', id: 1, params: { clientInfo: { name: 'system', title: 'system agents quota', version: '0' }, capabilities: null } },
    { method: 'initialized' }, { method: 'account/rateLimits/read', id: 2 },
  ])
})
for (const [kind, version] of [['claude', '2.1.999'], ['codex', '0.999.0'], ['claude', 'garbage'], ['codex', 'garbage'], ['claude', '2.1.308']] as const) {
  test(`${kind} rejects unverified version ${version} before any quota request`, async (t) => {
    const dir = tempDir('quota-version-')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const fake = fakeQuotaCli(dir, { kind, version, answer: {} })
    const report = kind === 'claude' ? await readClaudeQuota({ command: fake.command, home: dir, token: 'tok-1' }) : await readCodexQuota({ command: fake.command, codexHome: dir })
    unreadable(report, /not verified/)
    if (version !== 'garbage') assert.ok(String(object(report).unreadable).includes(version))
    assert.deepEqual(fake.readLog(), [{ argv: ['--version'] }])
  })
}
for (const [kind, mode, reason] of [
  ['claude', 'error', /get_usage failed/], ['claude', 'garbage', /JSON/i], ['claude', 'exit', /end|exit|closed/i],
  ['codex', 'error', /initialize|scripted/i], ['codex', 'exit', /end|exit|closed/i],
] as const) {
  test(`${kind} ${mode} is unreadable without throwing`, async (t) => {
    const dir = tempDir('quota-failure-')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const fake = fakeQuotaCli(dir, { kind, mode, version: kind === 'claude' ? '2.1.322' : '0.166.0', answer: {} })
    const report = kind === 'claude' ? await readClaudeQuota({ command: fake.command, home: dir, token: 'tok-1' }) : await readCodexQuota({ command: fake.command, codexHome: dir })
    unreadable(report, reason)
    assert.ok(fake.readLog().some((entry) => entry.stdin !== undefined))
  })
}
for (const stopped of [false, true]) {
  test(`Claude ${stopped ? 'abort' : 'timeout'} stops the hanging fake process`, async (t) => {
    const dir = tempDir('quota-stop-')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const fake = fakeQuotaCli(dir, { kind: 'claude', version: '2.1.322', answer: {}, mode: 'hang' })
    const abort = new AbortController()
    // Always release a hanging fake on assertion failure too.
    t.after(() => abort.abort())
    // The timeout leaves the fake time to start and log its PID on a loaded machine (dg-14).
    const pending = readClaudeQuota({ command: fake.command, home: dir, token: 'tok-1', timeoutMs: stopped ? 5000 : 3000, signal: abort.signal })
    if (stopped) {
      await until(() => existsSync(fake.log) && fake.readLog().some((entry) => entry.stdin !== undefined), 'fake received request')
      abort.abort()
    }
    unreadable(await pending, stopped ? /stopped/ : /timed out/)
    const pid = fake.readLog().find((entry) => typeof entry.pid === 'number')?.pid
    assert.equal(typeof pid, 'number', 'fake logged its PID before it could be stopped')
    assert.ok(typeof pid === 'number')
    await until(() => gone(pid), 'quota process exit')
  })
}
