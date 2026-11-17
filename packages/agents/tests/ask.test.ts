/**
 * cls-1: one model turn with no tools on an Account of a tier (`askOnce`, `AgentsService.ask`), through the same
 * Runtime machinery as an attempt, with the fake CLI. Never on an excluded Account.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { processSpawner } from '../../../test-support/process.ts'
import { askAccount, chooseAsker, type Account } from '../src/index.ts'

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs')
const root = mkdtempSync(join(tmpdir(), 'system-ask-'))
after(() => rmSync(root, { recursive: true, force: true }))

function account(ref: string, runtime: 'claude-code' | 'codex', models: Account['models'] = { economy: 'haiku' }): Account {
  return { ref, runtime, capabilities: [], command: fake, version: async () => 'v-fake', token: async () => 'tok', models, ...(runtime === 'codex' ? { codexHome: root } : {}) }
}

test('a Claude Code turn: the answer text, its model and Runtime version, on the economy model', async () => {
  const got = await askAccount(account('claude-code/e', 'claude-code'), processSpawner, root, 'say FAKE:env', { tier: 'economy' })
  assert.deepEqual(got, { ok: true, text: 'done', ref: 'claude-code/e', runtime: 'claude-code', model: 'haiku', runtimeVersion: 'v-fake' })
})

test('a failing turn is a refusal with the reason, never a throw', async () => {
  const got = await askAccount(account('claude-code/e', 'claude-code'), processSpawner, root, 'FAKE:fail', { tier: 'economy' })
  assert.equal(got.ok, false)
  assert.match((got as { reason: string }).reason, /claude-code\/e.*scripted failure/)
  const missing = await askAccount({ ...account('claude-code/e', 'claude-code'), token: async () => undefined }, processSpawner, root, 'x', { tier: 'economy' })
  assert.equal(missing.ok, false)
})

test('chooseAsker takes the first Account that offers the tier and is not excluded; none left is a refusal', async () => {
  const accounts = [account('claude-code/a', 'claude-code'), account('claude-code/b', 'claude-code', { standard: 's' }), account('claude-code/c', 'claude-code')]
  const ask = chooseAsker(() => accounts, processSpawner, root)
  const first = await ask('hi', { exclude: [] })
  assert.equal(first.ok && first.ref, 'claude-code/a')
  const second = await ask('hi', { exclude: ['claude-code/a'] })
  assert.equal(second.ok && second.ref, 'claude-code/c', 'b has no economy model')
  const none = await ask('hi', { exclude: ['claude-code/a', 'claude-code/c'] })
  assert.deepEqual(none, { ok: false, reason: 'no Account offers the economy tier besides claude-code/a, claude-code/c' })
})
