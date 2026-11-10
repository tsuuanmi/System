import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeClaudeHome, fakeCodexHome, tempDir } from '../../../test-support/accounts.ts'
import { readClaudeAccountId, readCodexAccountId } from '../src/identity.ts'

test('Claude: accountUuid wins over emailAddress; the email alone is used without a uuid', () => {
  assert.equal(readClaudeAccountId(fakeClaudeHome(undefined, { accountUuid: 'u', emailAddress: 'e@x' })), 'u')
  assert.equal(readClaudeAccountId(fakeClaudeHome(undefined, { emailAddress: 'e@x' })), 'e@x')
})

test('Claude: no file, bad JSON, no oauthAccount or an empty string is unknown', () => {
  const dir = tempDir()
  assert.equal(readClaudeAccountId(dir), undefined)
  writeFileSync(join(dir, '.claude.json'), '{nope')
  assert.equal(readClaudeAccountId(dir), undefined)
  writeFileSync(join(dir, '.claude.json'), '{}')
  assert.equal(readClaudeAccountId(dir), undefined)
  assert.equal(readClaudeAccountId(fakeClaudeHome(undefined, { accountUuid: '' })), undefined)
})

test('Codex: tokens.account_id is read and nothing else; missing pieces are unknown', () => {
  const id = readCodexAccountId(fakeCodexHome(undefined, 'acct'))
  assert.equal(id, 'acct')
  assert.doesNotMatch(id!, /SECRET-/)
  assert.equal(readCodexAccountId(tempDir()), undefined)
  const dir = tempDir()
  writeFileSync(join(dir, 'auth.json'), 'x')
  assert.equal(readCodexAccountId(dir), undefined)
  assert.equal(readCodexAccountId(fakeCodexHome(undefined)), undefined)
})
