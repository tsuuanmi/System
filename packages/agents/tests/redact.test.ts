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

// The fixture is built at run time so no key literal sits in the source.
const pemHeader = '-----BEGIN ' + 'PRIVATE KEY-----'
const pemFooter = '-----END ' + 'PRIVATE KEY-----'
const pemBody = ['A', 'B', 'C'].map((c) => c.repeat(64))

test('redactLog redacts a multi-line PEM block from BEGIN to END', () => {
  const out = redactLog(['before', pemHeader, ...pemBody, pemFooter, 'after'].join('\n'))
  for (const b of pemBody) assert.ok(!out.includes(b))
  assert.ok(!out.includes('PRIVATE KEY'))
  assert.ok(out.includes('[redacted:pem]'))
  assert.ok(out.startsWith('before\n') && out.endsWith('\nafter'))
})

test('redactLog redacts a PEM block cut before END to the end of the log', () => {
  const out = redactLog(['before', pemHeader, ...pemBody].join('\n'))
  for (const b of pemBody) assert.ok(!out.includes(b))
  assert.ok(out.startsWith('before\n'))
})

test('redactLog keeps the text after the END line and plain lines unchanged', () => {
  const log = 'one\ntwo'
  assert.equal(redactLog(log), log)
  const out = redactLog([pemHeader, ...pemBody, pemFooter + ' tail', 'last'].join('\n'))
  assert.ok(out.endsWith('tail\nlast'))
})

test('redactLog still redacts a PEM inside a JSON line', () => {
  const line = JSON.stringify({ text: [pemHeader, ...pemBody, pemFooter].join('\n') })
  const out = redactLog(line + '\nnext')
  for (const b of pemBody) assert.ok(!out.includes(b))
  assert.ok(out.endsWith('\nnext'))
})
