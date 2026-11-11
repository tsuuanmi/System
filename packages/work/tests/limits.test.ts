import assert from 'node:assert/strict'
import { test } from 'node:test'

// The module is new in sc-14. A dynamic path lets the tests compile before
// implementation; only the missing production module may fail at runtime.
const limitsPath = '../src/limits.ts'
for (const [reason, expected] of [
  ['codex/default exit 1: Your workspace is out of credits. Add credits to continue.', true],
  ['fake: 429 Too Many Requests', true],
  ['claude usage limit reached; rate limit resets at 5pm', true],
  ['usage limit reached', true],
  ['rate limit reached', true],
  ['quota exceeded', true],
  ['tests red', false],
  ['no change: the working tree is the same', false],
  [undefined, false],
] as const) {
  test(`quota limit classification: ${String(reason)}`, async () => {
    const { isQuotaLimited } = await import(limitsPath)
    assert.equal(typeof isQuotaLimited, 'function')
    assert.equal(isQuotaLimited(reason), expected)
  })
}
