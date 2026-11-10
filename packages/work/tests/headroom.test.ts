import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rankByHeadroom, type QuotaReading } from '../src/headroom.ts'

const read = (five: number, seven: number, resets: { five?: string; seven?: string } = {}): QuotaReading => ({
  windows: { five_hour: { percentUsed: five, ...(resets.five ? { resetsAt: resets.five } : {}) }, seven_day: { percentUsed: seven, ...(resets.seven ? { resetsAt: resets.seven } : {}) } },
})

test('the primary takes the step while both of its windows are under the ceiling', () => {
  const ranking = rankByHeadroom([
    { ref: 'a', priority: 'secondary', quota: read(1, 1) },
    { ref: 'p', priority: 'primary', quota: read(43, 31) },
  ])
  assert.equal(ranking.selected, 'p')
  assert.equal(ranking.reasons.get('p'), 'primary under 80% (5h 43%, 7d 31%)')
  assert.equal(ranking.wait, undefined)
})

test('a primary over the ceiling in either window gives way to the secondary with the most headroom', () => {
  for (const over of [read(91, 10), read(10, 85)]) {
    const ranking = rankByHeadroom([
      { ref: 'p', priority: 'primary', quota: over },
      { ref: 'a', quota: read(50, 20) },
      { ref: 'b', quota: read(30, 30) },
    ])
    assert.equal(ranking.selected, 'b')
    assert.match(ranking.reasons.get('p')!, /^over 80% \(/)
    assert.match(ranking.reasons.get('b')!, /^headroom 70% /)
  }
  assert.equal(rankByHeadroom([{ ref: 'p', priority: 'primary', quota: read(91, 10) }, { ref: 'a', quota: read(50, 20) }]).reasons.get('p'), 'over 80% (5h 91%)')
})

test('headroom is 100 minus the fuller window, and ties go to registration order', () => {
  assert.equal(rankByHeadroom([{ ref: 'a', quota: read(10, 70) }, { ref: 'b', quota: read(60, 5) }]).selected, 'b')
  assert.equal(rankByHeadroom([{ ref: 'a', quota: read(40, 10) }, { ref: 'b', quota: read(10, 40) }]).selected, 'a')
})

test('the ceiling is configuration: 90 lets an account at 85% take the step', () => {
  assert.equal(rankByHeadroom([{ ref: 'a', quota: read(85, 0) }], 90).selected, 'a')
  assert.equal(rankByHeadroom([{ ref: 'a', quota: read(85, 0) }]).selected, undefined)
})

test('an unreadable or quota-less account ranks after every readable one under the ceiling, and stays usable', () => {
  const ranking = rankByHeadroom([
    { ref: 'web' },
    { ref: 'broken', quota: { unreadable: 'unknown CLI version' } },
    { ref: 'full', quota: read(90, 0) },
    { ref: 'ok', quota: read(79, 79) },
  ])
  assert.equal(ranking.selected, 'ok')
  assert.equal(ranking.reasons.get('broken'), 'quota unreadable: unknown CLI version')
  assert.equal(rankByHeadroom([{ ref: 'web' }, { ref: 'broken', quota: { unreadable: 'x' } }, { ref: 'full', quota: read(90, 0) }]).selected, 'web', 'profile order among the unreadable; the over-ceiling one is not chosen')
  assert.equal(rankByHeadroom([{ ref: 'p', priority: 'primary', quota: { unreadable: 'x' } }, { ref: 'a', quota: { unreadable: 'y' } }]).selected, 'p')
})

test('every account over the ceiling and none unreadable: no choice, wait for the earliest reset', () => {
  const ranking = rankByHeadroom([
    { ref: 'a', quota: read(91, 10, { five: '2026-11-10T12:00:00.000Z' }) },
    { ref: 'b', quota: read(10, 95, { seven: '2026-11-10T09:00:00.000Z' }) },
    { ref: 'c', quota: read(99, 99, { five: '2026-11-10T08:00:00.000Z', seven: '2026-11-11T00:00:00.000Z' }) },
  ])
  assert.equal(ranking.selected, undefined)
  assert.deepEqual(ranking.wait, { ref: 'b', resetsAt: '2026-11-10T09:00:00.000Z' })
  assert.deepEqual(rankByHeadroom([{ ref: 'a', quota: read(91, 10) }]).wait, { ref: 'a' }, 'no reset known')
  assert.equal(rankByHeadroom([]).wait, undefined)
})
