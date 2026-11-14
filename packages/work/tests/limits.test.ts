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

const NOW = Date.parse('2026-11-14T12:00:00Z')
for (const [reason, expected] of [
  ['usage limit reached; resets at 2026-11-14T15:30:00Z', '2026-11-14T15:30:00.000Z'],
  ['Claude AI usage limit reached|1794672000', new Date(1794672000 * 1000).toISOString()],
  ['rate limit: try again in 2 hours', '2026-11-14T14:00:00.000Z'],
  ['rate limit: try again in 45 minutes', '2026-11-14T12:45:00.000Z'],
  ["You've hit your limit · resets 3pm (UTC)", '2026-11-14T15:00:00.000Z'],
  ["You've hit your limit · resets 11:30am (UTC)", '2026-11-15T11:30:00.000Z'],
  ['usage limit reached', undefined],
  ['usage limit reached; resets at 2026-11-14T10:00:00Z', undefined],
  ['usage limit reached; resets at 2027-11-14T10:00:00Z', undefined],
] as const) {
  test(`quota reset from the error text: ${reason}`, async () => {
    const { quotaResetFrom } = await import(limitsPath)
    assert.equal(quotaResetFrom(reason, NOW), expected === undefined ? undefined : Date.parse(expected))
  })
}
