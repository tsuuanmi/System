import assert from 'node:assert/strict'
import { test } from 'node:test'
import { maskValues, redactLog, redactString } from '../src/redact.ts'

test('provider keys, Bearer tokens, URL user-info and .env lines are redacted; other text is not', () => {
  assert.equal(redactString('key sk-ant-' + 'a'.repeat(50) + ' end'), 'key [redacted:anthropic-key] end')
  assert.equal(redactString('ghp_' + 'a'.repeat(36)), '[redacted:github-token]')
  assert.equal(redactString('Authorization: Bearer abc.def-123'), '[redacted:labeled-kv]')
  assert.equal(redactString('git clone https://user:pw@host.example/r.git'), 'git clone https://[redacted]@host.example/r.git')
  assert.equal(redactString('A=1\nSECRET_VAR=hunter2\n'), 'A=[redacted:env-value]\nSECRET_VAR=[redacted:env-value]\n')
  assert.equal(redactString('{"password": "hunter2"}'), '{[redacted:labeled-kv]}')
  assert.equal(redactString('nothing to see: 12 files, 3 tokens'), 'nothing to see: 12 files, 3 tokens')
  const once = redactString('x_token=abc123 PATH=/bin')
  assert.equal(redactString(once), once)
})

test('a JSON line is redacted by its values and key names; the blocklist keeps the line parseable', () => {
  const out = redactLog(JSON.stringify({ env: 'HOME=/h', api_key: 'zzzzzz', apiKeySource: 'none', n: 1 }))
  assert.deepEqual(JSON.parse(out), { env: '[redacted:key]', api_key: '[redacted:key]', apiKeySource: 'none', n: 1 })
})

test('maskValues masks a value plain and JSON-escaped, and ignores one under 3 characters', () => {
  assert.equal(maskValues('a"b a\\"b ab', ['a"b']), '[redacted] [redacted] ab')
  assert.equal(maskValues('ab', ['ab', undefined]), 'ab')
})
