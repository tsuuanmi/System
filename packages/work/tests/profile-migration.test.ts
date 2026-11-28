/**
 * rt-4 (ADR-0018 decisions 3 to 5): a profile that still patches the rows `agents` or `web-worker`, or lists a `runtime: web` Account under the
 * CLI row, is refused with the exact YAML to write instead. The refusal names the rows and never rewrites anything.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from 'yaml'
import { profileMigration } from '../src/profile-migration.ts'

const cli = { ref: 'claude-code/c2', runtime: 'claude-code', capabilities: ['develop.implement'], command: '/bin/claude' }
const web = { ref: 'web/chatgpt/default', runtime: 'web', site: 'chatgpt', capabilities: ['research.lane-a'] }

/** The rows the refusal prints: the YAML after its first blank line. */
const printed = (message: string): { id: string; disabled?: boolean; config?: { accounts?: { ref: string }[]; attemptTimeoutMinutes?: number } }[] =>
  parse(message.slice(message.indexOf('\n\n') + 2).split('\n\n')[0]!) as never

test('a profile with the new rows and no web Account under the CLI row is not refused', () => {
  assert.equal(profileMigration([]), undefined)
  assert.equal(profileMigration([{ id: 'runtime-cli', config: { accounts: [cli] } }, { id: 'runtime-web', disabled: false, config: { accounts: [web] } }]), undefined)
  assert.equal(profileMigration([{ id: 'effects', config: { base: 'dev' } }]), undefined)
})

test('the old row ids are refused naming both rows, with the new rows to write', () => {
  const message = profileMigration([
    { id: 'agents', config: { attemptTimeoutMinutes: 30, accounts: [cli, web] } },
    { id: 'web-worker', disabled: false, config: { registerWaitSeconds: 10 } },
  ])!
  assert.match(message, /\bagents\b/)
  assert.match(message, /\bweb-worker\b/)
  const rows = printed(message)
  assert.deepEqual(rows.map((row) => row.id), ['runtime-cli', 'runtime-web'])
  assert.deepEqual(rows[0]!.config!.accounts!.map((a) => a.ref), ['claude-code/c2'])
  assert.equal(rows[0]!.config!.attemptTimeoutMinutes, 30)
  assert.equal(rows[1]!.disabled, false)
  assert.deepEqual(rows[1]!.config!.accounts!.map((a) => a.ref), ['web/chatgpt/default'])
  assert.doesNotMatch(message, /registerWaitSeconds: 10/, 'the 30 s and 60 s waits are gone')
})

test('a web Account under the old agents row alone turns the web row on', () => {
  const rows = printed(profileMigration([{ id: 'agents', config: { accounts: [web] } }])!)
  assert.deepEqual(rows.map((row) => row.id), ['runtime-cli', 'runtime-web'])
  assert.equal(rows[1]!.disabled, false)
})

test('a web Account under the new CLI row is refused, and its row moves', () => {
  const message = profileMigration([{ id: 'runtime-cli', config: { accounts: [cli, web] } }])!
  assert.match(message, /runtime-cli/)
  assert.match(message, /web\/chatgpt\/default/)
  const rows = printed(message)
  assert.deepEqual(rows.map((row) => row.id), ['runtime-cli', 'runtime-web'])
  assert.deepEqual(rows[0]!.config!.accounts!.map((a) => a.ref), ['claude-code/c2'])
  assert.deepEqual(rows[1]!.config!.accounts!.map((a) => a.ref), ['web/chatgpt/default'])
})

test('a patch of the old web-worker row alone is refused with the same fields under the new id', () => {
  const rows = printed(profileMigration([{ id: 'web-worker', disabled: false }])!)
  assert.deepEqual(rows, [{ id: 'runtime-web', disabled: false }])
})
