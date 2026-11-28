/** The Runtime adapters (adapters/): one per CLI Runtime, found by name, so no other module branches on a Runtime's name. */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeCodexHome, tempDir } from '../../../test-support/accounts.ts'
import { adapterFor } from '../src/adapters/index.ts'
import type { Account } from '../src/agent.ts'
import { RUNTIME_ABILITIES } from '../src/runtimes.ts'

const src = join(import.meta.dirname, '..', 'src')
const account = (runtime: Account['runtime'], extra: Partial<Account> = {}): Account => ({ ref: `${runtime}/a`, runtime, capabilities: [], command: 'cli', version: async () => 'v', ...extra })

test('no `runtime ===` branch exists outside the adapters and the web seam (web.ts)', () => {
  const branch = /\bruntime\s*[!=]==?\s*['"`]|['"`](?:claude-code|codex|web)['"`]\s*[!=]==?\s*\S*runtime\b|\bcase\s+['"`](?:claude-code|codex)['"`]/
  const offenders = readdirSync(src).filter((f) => f.endsWith('.ts') && f !== 'web.ts')
    .flatMap((f) => readFileSync(join(src, f), 'utf8').split('\n').map((text, i) => ({ at: `${f}:${i + 1}`, text })).filter(({ text }) => branch.test(text.replace(/\/\/.*$/, ''))))
  assert.deepEqual(offenders, [])
})

test('every adapter is registered under its own Runtime name and declares abilities', () => {
  for (const runtime of ['claude-code', 'codex', 'antigravity'] as const) {
    assert.equal(adapterFor(runtime)?.runtime, runtime)
    assert.ok(RUNTIME_ABILITIES[runtime].length > 0)
  }
  assert.equal(adapterFor('unknown'), undefined)
})

test('Claude Code preflight refuses without a token; with one it stages the token as the only variable', async () => {
  const adapter = adapterFor('claude-code')!
  assert.deepEqual(await adapter.preflight(account('claude-code', { token: async () => undefined })), { failed: 'claude-code/a: its token is not configured (system credentials set)' })
  const pre = await adapter.preflight(account('claude-code', { token: async () => 'tok' }))
  assert.ok('stage' in pre)
  assert.deepEqual(pre.stage(tempDir()).env, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' })
})

test('Codex preflight refuses without auth.json; staging copies it into a fresh home, and a refreshed login is kept', async () => {
  const adapter = adapterFor('codex')!
  const empty = tempDir()
  assert.deepEqual(await adapter.preflight(account('codex', { codexHome: empty })), { failed: `codex/a: no auth.json in ${empty} (codex login --device-auth)` })
  const home = fakeCodexHome(undefined, 'acct')
  const pre = await adapter.preflight(account('codex', { codexHome: home }))
  assert.ok('stage' in pre)
  const dir = tempDir()
  const staged = pre.stage(dir)
  assert.equal(staged.env.CODEX_HOME, join(dir, 'codex-home'))
  const before = readFileSync(join(home, 'auth.json'), 'utf8')
  assert.equal(readFileSync(join(staged.env.CODEX_HOME!, 'auth.json'), 'utf8'), before)
  writeFileSync(join(staged.env.CODEX_HOME!, 'auth.json'), '{"refreshed":true}')
  staged.finish()
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), '{"refreshed":true}')
})

test('a turn with no tools: Claude Code gets no tools, Codex a read-only sandbox', () => {
  const input = { command: 'cli', prompt: 'p', model: 'm', work: '/w' }
  const claude = adapterFor('claude-code')!.askArgv(input)
  assert.deepEqual(claude.slice(claude.indexOf('--tools')), ['--tools', ''])
  const codex = adapterFor('codex')!.askArgv(input)
  assert.equal(codex[codex.indexOf('-s') + 1], 'read-only')
})

test('only Claude Code reports quota windows from its stream', () => {
  assert.equal(adapterFor('codex')!.rateLimitEvents, undefined)
  assert.deepEqual(adapterFor('claude-code')!.rateLimitEvents!('not json\n'), [])
})
