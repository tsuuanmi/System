import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { QuotaReport } from '../../agents/src/quota.ts'

// Test-side contract from the SC plan. A URL import lets these tests compile
// before headroom.ts exists; each case still fails on that missing module.
interface Candidate {
  ref: string
  priority?: 'primary' | 'secondary'
  reading: QuotaReport | undefined
  ceiling: number
}
interface Ranked { selected?: string; reasons: Record<string, string>; waitUntil?: { resetsAt?: string } }
async function rank(candidates: Candidate[]): Promise<Ranked> {
  const { rankByHeadroom } = await import(new URL('../src/headroom.ts', import.meta.url).href)
  assert.equal(typeof rankByHeadroom, 'function')
  return rankByHeadroom(candidates)
}
const reading = (five: number, seven?: number): QuotaReport => ({ observedAt: '2026-11-10T00:00:00Z', windows: { five_hour: { percentUsed: five }, ...(seven === undefined ? {} : { seven_day: { percentUsed: seven } }) } })
const legacyCandidate = (ref: string, quota: QuotaReport | undefined, priority: Candidate['priority'] = 'secondary', ceiling = 80): Candidate => ({ ref, reading: quota, priority, ceiling })

test('primary under the ceiling wins even with less headroom', async () => {
  const result = await rank([legacyCandidate('S', reading(10)), legacyCandidate('P', reading(43, 31), 'primary')])
  assert.equal(result.selected, 'P')
  assert.equal(result.reasons.P, 'primary under 80% (5h 43%, 7d 31%)')
})
for (const [window, quota] of [['5h', reading(91, 31)], ['7d', reading(31, 91)]] as const) {
  test(`primary over only in ${window} yields to secondary`, async () => {
    const result = await rank([legacyCandidate('P', quota, 'primary'), legacyCandidate('S', reading(43))])
    assert.equal(result.selected, 'S')
    assert.equal(result.reasons.P, `over 80% (${window} 91%)`)
  })
}
test('each candidate uses its configured ceiling', async () => {
  const result = await rank([legacyCandidate('P', reading(91, 31), 'primary', 95), legacyCandidate('S', reading(10))])
  assert.equal(result.selected, 'P')
  assert.equal(result.reasons.P, 'primary under 95% (5h 91%, 7d 31%)')
})
test('most headroom wins, using the larger window', async () => {
  const result = await rank([legacyCandidate('A', reading(10, 60)), legacyCandidate('B', reading(30, 20)), legacyCandidate('C', reading(20, 45))])
  assert.equal(result.selected, 'B')
  assert.match(result.reasons.B!, /^headroom 70%(?: \(|$)/)
})
test('headroom ties go to profile order', async () => {
  assert.equal((await rank([legacyCandidate('z-first', reading(20, 40)), legacyCandidate('a-later', reading(40, 20))])).selected, 'z-first')
})
test('exactly at the ceiling counts as over, including for primary', async () => {
  const result = await rank([legacyCandidate('P', reading(80), 'primary'), legacyCandidate('S', reading(79))])
  assert.equal(result.selected, 'S')
  assert.equal(result.reasons.P, 'over 80% (5h 80%)')
})
test('unreadable primary ranks after readable under-ceiling secondary', async () => {
  assert.equal((await rank([legacyCandidate('P', { unreadable: 'unknown version' }, 'primary'), legacyCandidate('S', reading(70))])).selected, 'S')
})
test('only unreadable accounts, including web with no reader, use profile order', async () => {
  const accounts = [legacyCandidate('A', { unreadable: 'unknown version' }), legacyCandidate('web', undefined), legacyCandidate('B', { unreadable: 'offline' })]
  const result = await rank(accounts)
  assert.equal(result.selected, 'A')
  assert.equal(result.reasons.A, 'quota unreadable: unknown version')
  assert.equal(result.reasons.web, 'no quota reader')
  assert.equal((await rank([accounts[1]!, accounts[0]!])).selected, 'web')
})
test('unreadable stays usable when every readable account is over', async () => {
  assert.equal((await rank([legacyCandidate('P', reading(91), 'primary'), legacyCandidate('S', { unreadable: 'offline' })])).selected, 'S')
})
test('empty windows are unreadable and rank after a readable account', async () => {
  const empty = legacyCandidate('empty', { observedAt: '2026-11-10T00:00:00Z', windows: {} }, 'primary')
  assert.equal((await rank([empty, legacyCandidate('S', reading(79))])).selected, 'S')
  assert.equal((await rank([empty])).selected, 'empty')
})
test('all over waits for earliest over-window reset, ignoring earlier under-window resets', async () => {
  const result = await rank([
    legacyCandidate('A', { observedAt: '2026-11-10T00:00:00Z', windows: { five_hour: { percentUsed: 91, resetsAt: '2026-11-10T05:00:00Z' }, seven_day: { percentUsed: 31, resetsAt: '2026-11-10T01:00:00Z' } } }),
    legacyCandidate('B', { observedAt: '2026-11-10T00:00:00Z', windows: { seven_day: { percentUsed: 92, resetsAt: '2026-11-10T07:00:00+05:00' } } }),
  ])
  assert.equal(result.selected, undefined)
  assert.deepEqual(result.waitUntil, { resetsAt: '2026-11-10T07:00:00+05:00' })
})
test('all over without known reset returns an empty waitUntil', async () => {
  const result = await rank([legacyCandidate('A', reading(81)), legacyCandidate('B', reading(20, 90))])
  assert.equal(result.selected, undefined)
  assert.deepEqual(result.waitUntil, {})
})
test('no candidates means no selection and no quota wait', async () => {
  const result = await rank([])
  assert.equal(result.selected, undefined)
  assert.equal(result.waitUntil, undefined)
})
test('two primaries under the ceiling use profile order, even across runtimes', async () => {
  const result = await rank([legacyCandidate('claude/P', reading(70), 'primary'), legacyCandidate('codex/P', reading(10), 'primary')])
  assert.equal(result.selected, 'claude/P')
})

// ro-7 contract; the old primary assertions above are updated by implement.
const candidate = (ref: string, quota: QuotaReport | undefined, attempts = 0, ceiling = 80) => ({ ref, reading: quota, attempts, ceiling })

test('most headroom wins; no Account is preferred', async () => {
  const b = candidate('B', reading(43, 31))
  // Old profiles may still supply this field; it must confer no preference.
  Reflect.set(b, 'priority', 'primary')
  const result = await rank([candidate('A', reading(10)), b])
  assert.equal(result.selected, 'A')
  assert.equal(result.reasons.B, 'headroom 57% (5h 43%, 7d 31%)')
})
test('equal headroom goes to the fewest attempts that day', async () => {
  assert.equal((await rank([candidate('A', reading(40), 5), candidate('B', reading(40), 2)])).selected, 'B')
})
test('equal headroom and attempts go to registration order', async () => {
  assert.equal((await rank([candidate('z-first', reading(40), 2), candidate('a-later', reading(40), 2)])).selected, 'z-first')
})
test('unreadable Accounts tie by fewest attempts, then registration order', async () => {
  assert.equal((await rank([
    candidate('default', { unreadable: 'x' }, 344),
    candidate('c2', { unreadable: 'x' }, 4),
    candidate('c3', { unreadable: 'x' }, 4),
  ])).selected, 'c2')
})
test('a readable Account under the ceiling still beats unreadable ones with fewer attempts', async () => {
  assert.equal((await rank([candidate('blind', { unreadable: 'x' }), candidate('readable', reading(70), 344)])).selected, 'readable')
})
