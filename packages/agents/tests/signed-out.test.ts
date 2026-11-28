/** authgate-1: a quota read that fails with an authentication error makes the Account `signed out` until a later read succeeds. */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeClaudeHome, fakeCodexHome, tempDir } from '../../../test-support/accounts.ts'
import { claudeUsage, codexRateLimits, fakeQuotaCli, object } from '../../../test-support/quota.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { apply, type AccountConfig, type AgentsService } from '../src/index.ts'
import { readAntigravityQuota } from '../src/quota.ts'
import type { WorkerPort } from '../../work/src/registry.ts'

async function mount(dir: string, accounts: AccountConfig[], now: () => number) {
  const services: Record<string, unknown> = {
    storageDomain: { open: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }) },
    dshHomePath: (...segments: string[]) => join(dir, ...segments),
    artifacts: memoryArtifacts(),
    subprocess: { resolveExecutable: async (c: string): Promise<string> => c, spawn: (): never => { throw new Error('registration must not spawn') } },
    credentials: { describe: async (): Promise<{ configured: boolean }> => ({ configured: true }), resolve: async (): Promise<{ value: string }> => ({ value: 'tok' }) },
    capabilities: { registerWorker: (_worker: WorkerPort): (() => void) => () => {} },
  }
  let agents: unknown
  const ctx = { baseDir: dir, get: (key: string): unknown => services[key], effect: (_fn: () => () => void): void => {}, provide: (key: string, value: unknown): void => { if (key === 'agents') agents = value } }
  await apply(ctx as never, { accounts, quota: { now } } as never)
  object(agents)
  return agents as AgentsService
}

const SIGNED_OUT = {
  'claude-code': ['Invalid API key · Please run /login', 'OAuth token has expired. Please run /login'],
  codex: ['Not logged in', 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'],
} as const

for (const runtime of ['claude-code', 'codex'] as const) {
  for (const text of SIGNED_OUT[runtime]) {
    test(`${runtime}: "${text.slice(0, 30)}" makes the Account unavailable (signed out) until a later read succeeds`, async (t) => {
      const dir = tempDir('signed-out-')
      t.after(() => rmSync(dir, { recursive: true, force: true }))
      const errorFile = join(dir, 'error.txt')
      writeFileSync(errorFile, text)
      const spec: AccountConfig = runtime === 'codex'
        ? { ref: 'codex/x1', runtime, capabilities: ['research'], command: fakeQuotaCli(join(dir, 'cli'), { kind: 'codex', version: '0.166.0', errorFile, answer: codexRateLimits({ primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1794319200 } }) }).command, codexHome: fakeCodexHome(join(dir, 'home'), 'codex-account') }
        : { ref: 'claude-code/c1', runtime, capabilities: ['research'], command: fakeQuotaCli(join(dir, 'cli'), { kind: 'claude', version: '2.1.322', errorFile, answer: claudeUsage({ five_hour: { utilization: 42, resets_at: '2026-11-10T14:00:00.000Z' } }) }).command, claudeHome: fakeClaudeHome(join(dir, 'home'), { accountUuid: 'claude-account' }) }
      let now = Date.parse('2026-11-10T12:00:00.000Z')
      const row = await mount(dir, [spec], () => now)
      assert.equal((await row.accounts())[0]!.available, true, 'nothing is read at registration')
      const report = await row.quota(spec.ref)
      assert.equal((report as { signedOut?: boolean }).signedOut, true, JSON.stringify(report))
      const [signedOut] = await row.accounts()
      assert.equal(signedOut!.available, false)
      assert.equal(signedOut!.reason, 'signed out')
      rmSync(errorFile)
      now += 600_001
      assert.ok('windows' in await row.quota(spec.ref))
      assert.equal((await row.accounts())[0]!.available, true)
    })
  }
}

test('an unreadable quota that is not an authentication error leaves the Account available', async (t) => {
  const dir = tempDir('signed-out-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const errorFile = join(dir, 'error.txt')
  writeFileSync(errorFile, 'scripted failure')
  const spec: AccountConfig = { ref: 'claude-code/c1', runtime: 'claude-code', capabilities: ['research'], command: fakeQuotaCli(join(dir, 'cli'), { kind: 'claude', version: '2.1.322', errorFile, answer: {} }).command, claudeHome: fakeClaudeHome(join(dir, 'home'), { accountUuid: 'claude-account' }) }
  const row = await mount(dir, [spec], () => Date.parse('2026-11-10T12:00:00.000Z'))
  const report = await row.quota(spec.ref)
  assert.ok('unreadable' in report && !report.signedOut)
  assert.equal((await row.accounts())[0]!.available, true)
})

for (const text of ['authentication failed or timed out', 'Authentication required']) {
  test(`antigravity: an ERROR result "${text}" is a signed-out read`, async (t) => {
    const dir = tempDir('signed-out-agy-')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const bin = join(dir, 'agy')
    writeFileSync(bin, `#!/bin/sh\necho '{"status":"ERROR","error":"${text}"}'\n`)
    chmodSync(bin, 0o700)
    const report = await readAntigravityQuota({ command: bin, home, group: 'gemini' })
    assert.deepEqual(report, { unreadable: `usage failed: ${text}`, signedOut: true })
  })
}

test('antigravity: another ERROR result or a missing group is not signed out', async (t) => {
  const dir = tempDir('signed-out-agy-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const bin = join(dir, 'agy')
  writeFileSync(bin, `#!/bin/sh\necho '{"status":"ERROR","error":"Eligibility check failed: not eligible"}'\n`)
  chmodSync(bin, 0o700)
  const report = await readAntigravityQuota({ command: bin, home, group: 'gemini' })
  assert.ok('unreadable' in report && report.signedOut === undefined)
})
