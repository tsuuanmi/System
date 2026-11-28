/** sc-3's parser and cache contract: synthetic answers, no CLI or account access. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { claudeUsage, codexRateLimits, object } from '../../../test-support/quota.ts'
import type { QuotaEvent } from '../src/quota.ts'
import { quotaFromUsage, quotaFromRateLimits, quotaFromRateLimitEvent, createQuotaCache, NO_PLAN_LIMITS } from '../src/quota.ts'

const OBS = Date.parse('2026-11-10T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const FIVE = '2026-11-10T14:00:00.000Z'
const SEVEN = '2026-11-15T09:00:00.000Z'
const cw = (utilization: unknown = 42, resets_at: unknown = FIVE) => ({ utilization, resets_at })
const xw = (usedPercent: unknown = 42, windowDurationMins: unknown = 300, resetsAt: unknown = Date.parse(FIVE) / 1000) => ({ usedPercent, windowDurationMins, resetsAt })
const expected = () => ({ observedAt: iso(OBS), windows: { five_hour: { percentUsed: 42, resetsAt: FIVE }, seven_day: { percentUsed: 17.5, resetsAt: SEVEN } } })
function unreadable(value: unknown, reason?: RegExp) {
  const report = object(value)
  assert.deepEqual(Object.keys(report), ['unreadable'])
  assert.equal(typeof report.unreadable, 'string')
  assert.ok(typeof report.unreadable === 'string' && report.unreadable.length > 0)
  if (reason) assert.match(report.unreadable, reason)
}
const windows = (report: unknown) => object(object(report).windows)

test('Claude normalizes both percentage windows and ISO resets', () => {
  assert.deepEqual(quotaFromUsage(claudeUsage({ five_hour: cw(), seven_day: cw(17.5, '2026-11-15T09:00:00+00:00') }), OBS), expected())
})
test('Claude ignores every unrelated entry, even junk', () => {
  assert.deepEqual(quotaFromUsage(claudeUsage({ five_hour: cw(), seven_day: cw(17.5, SEVEN), extra: { model_scoped: [{ display_name: 'x', utilization: 3, resets_at: null }], extra_usage: { utilization: 'junk' }, seven_day_opus: null, seven_day_oauth_apps: 7, unknown: 'junk' } }), OBS), expected())
})
test('Claude null windows and null utilization are absent, but neither window is unreadable', () => {
  for (const five_hour of [null, cw(null, null), undefined]) {
    assert.deepEqual(windows(quotaFromUsage(claudeUsage({ five_hour, seven_day: cw(17.5, SEVEN) }), OBS)), { seven_day: { percentUsed: 17.5, resetsAt: SEVEN } })
  }
  unreadable(quotaFromUsage(claudeUsage(), OBS), /does not match the checked schema/)
})
for (const [label, bad] of [
  ['negative', cw(-1)], ['over 100', cw(101)], ['string share', cw('42')], ['NaN', cw(NaN)],
  ['number window', 7], ['string window', 'x'], ['array window', []],
  ['seconds reset', cw(42, 1792851600)], ['invalid reset', cw(42, 'tomorrow')],
] as const) {
  test(`Claude ${label} makes the entire answer unreadable`, () => {
    unreadable(quotaFromUsage(claudeUsage({ five_hour: bad, seven_day: cw(17.5, SEVEN) }), OBS), /five_hour/)
    unreadable(quotaFromUsage(claudeUsage({ five_hour: cw(), seven_day: bad }), OBS), /seven_day/)
  })
}
test('Claude requires the availability boolean and a rate_limits object', () => {
  for (const answer of [null, 7, [], {}, { rate_limits_available: false }, { rate_limits: {} }, { rate_limits_available: true, rate_limits: [] }]) unreadable(quotaFromUsage(answer, OBS))
})
const resetCases: ReadonlyArray<readonly [number, number, boolean]> = [
  [100, -3_600_000, false], [100, 3 * 3_600_000, true], [50, 401 * 86_400_000, false],
  [50, 399 * 86_400_000, true], [100, 401 * 86_400_000, false], [50, -3_600_000, true],
]
for (const [percentUsed, delta, kept] of resetCases) {
  test(`Claude reset at ${percentUsed}% and offset ${delta} is ${kept ? 'kept' : 'dropped'}`, () => {
    assert.deepEqual(windows(quotaFromUsage(claudeUsage({ five_hour: cw(percentUsed, iso(OBS + delta)) }), OBS)), { five_hour: { percentUsed, ...(kept ? { resetsAt: iso(OBS + delta) } : {}) } })
  })
  test(`Codex reset at ${percentUsed}% and offset ${delta} is ${kept ? 'kept' : 'dropped'}`, () => {
    assert.deepEqual(windows(quotaFromRateLimits(codexRateLimits({ primary: xw(percentUsed, 300, (OBS + delta) / 1000) }), OBS)), { five_hour: { percentUsed, ...(kept ? { resetsAt: iso(OBS + delta) } : {}) } })
  })
}
test('Codex reads the snapshot, ignoring metadata, and converts seconds to ISO', () => {
  assert.deepEqual(quotaFromRateLimits(codexRateLimits({ primary: xw(), secondary: xw(17.5, 10080, Date.parse(SEVEN) / 1000) }), OBS), expected())
})
test('Codex maps by duration, not primary/secondary name, and skips unrelated durations', () => {
  assert.deepEqual(quotaFromRateLimits(codexRateLimits({ primary: xw(17.5, 10080, Date.parse(SEVEN) / 1000), secondary: xw() }), OBS), expected())
  for (const duration of [60, null]) {
    assert.deepEqual(windows(quotaFromRateLimits(codexRateLimits({ primary: xw(9, duration), secondary: xw() }), OBS)), { five_hour: { percentUsed: 42, resetsAt: FIVE } })
    unreadable(quotaFromRateLimits(codexRateLimits({ primary: xw(9, duration) }), OBS))
  }
  assert.deepEqual(windows(quotaFromRateLimits(codexRateLimits({ primary: xw(), secondary: null }), OBS)), { five_hour: { percentUsed: 42, resetsAt: FIVE } })
})
for (const [label, bad] of [
  ['negative', xw(-1)], ['over 100', xw(100.5)], ['string share', xw('9')], ['number window', 3],
  ['ISO reset', xw(9, 300, FIVE)], ['milliseconds reset', xw(9, 300, 1794000000000)], ['zero duration', xw(9, 0)],
] as const) {
  test(`Codex ${label} makes the whole report unreadable`, () => {
    unreadable(quotaFromRateLimits(codexRateLimits({ primary: bad, secondary: xw(17.5, 10080) }), OBS))
  })
}
test('Codex requires rateLimits', () => { unreadable(quotaFromRateLimits({}, OBS)) })
test('Claude events use fractions and seconds; rejected without a share means 100%', () => {
  const event = (info: object) => ({ type: 'rate_limit_event', rate_limit_info: info })
  assert.deepEqual(quotaFromRateLimitEvent(event({ status: 'allowed', rateLimitType: 'five_hour', utilization: .42, resetsAt: Date.parse(FIVE) / 1000 }), OBS), [{ window: 'five_hour', percentUsed: 42, resetsAt: FIVE }])
  assert.deepEqual(quotaFromRateLimitEvent(event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.parse(FIVE) / 1000 }), OBS), [{ window: 'five_hour', percentUsed: 100, resetsAt: FIVE }])
  for (const info of [{ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: .42 }, { status: 'allowed', rateLimitType: 'five_hour' }, { status: 'allowed', rateLimitType: 'five_hour', utilization: 1.3 }]) assert.deepEqual(quotaFromRateLimitEvent(event(info), OBS), [])
  assert.deepEqual(quotaFromRateLimitEvent({ type: 'result' }, OBS), [])
})
const CODEX_171 = JSON.parse(readFileSync(new URL('./codex-0.171.0-rate-limits.json', import.meta.url), 'utf8')) as unknown
test("Codex 0.171.0's real answer reads as 5h 30% and 7d 5% with their resets", () => {
  assert.deepEqual(quotaFromRateLimits(CODEX_171, OBS), { observedAt: iso(OBS), windows: { five_hour: { percentUsed: 30, resetsAt: iso(1795695432_000) }, seven_day: { percentUsed: 5, resetsAt: iso(1796282232_000) } } })
})
test('an answer with no window, or a window without a reset, is unreadable with the schema error', () => {
  unreadable(quotaFromRateLimits(codexRateLimits({}), OBS), /does not match the checked schema/)
  unreadable(quotaFromRateLimits(codexRateLimits({ primary: xw(9, 300, null) }), OBS), /does not match the checked schema.*resetsAt/)
  unreadable(quotaFromRateLimits(codexRateLimits({ primary: xw('9') }), OBS), /does not match the checked schema/)
  unreadable(quotaFromUsage(claudeUsage({}), OBS), /does not match the checked schema/)
  unreadable(quotaFromUsage(claudeUsage({ five_hour: cw(42, null) }), OBS), /does not match the checked schema.*resets_at/)
  unreadable(quotaFromUsage(claudeUsage({ five_hour: cw(), seven_day: cw(120) }), OBS), /does not match the checked schema/)
})
test('cache does not read again before the provider retry-after, nor before an exhausted window resets', async () => {
  let now = OBS
  let reads = 0
  let answer: unknown = { unreadable: 'the app server refused account/rateLimits/read: slow down', retryAfterMs: 1_800_000 }
  const cache = createQuotaCache({ ttlMs: 600_000, now: () => now, read: async () => { reads++; return answer as never } })
  await cache.get()
  now += 1_700_000
  await cache.get()
  assert.equal(reads, 1)
  now += 100_001
  answer = { observedAt: iso(now), windows: { five_hour: { percentUsed: 100, resetsAt: iso(now + 3_600_000) } } }
  await cache.get()
  assert.equal(reads, 2)
  now += 3_000_000
  await cache.get()
  assert.equal(reads, 2)
  now += 600_001
  await cache.get()
  assert.equal(reads, 3)
})
test('cache reuses readings for ten minutes and rereads after expiry', async () => {
  let now = OBS
  let reads = 0
  const cache = createQuotaCache({ now: () => now, read: async () => { reads++; return expected() } })
  assert.deepEqual(await cache.get(), expected())
  now += 599_999
  assert.deepEqual(await cache.get(), expected())
  assert.equal(reads, 1)
  now += 2
  await cache.get()
  assert.equal(reads, 2)
})
test('simultaneous cache gets share one pending read', async () => {
  let reads = 0
  let release!: (value: ReturnType<typeof expected>) => void
  const cache = createQuotaCache({ now: () => OBS, read: () => { reads++; return new Promise<ReturnType<typeof expected>>((resolve) => { release = resolve }) } })
  const a = cache.get()
  const b = cache.get()
  await Promise.resolve()
  assert.equal(reads, 1)
  release(expected())
  assert.deepEqual(await Promise.all([a, b]), [expected(), expected()])
})
test('observing an event merges a window and timestamp without extending the original expiry', async () => {
  let now = OBS
  let reads = 0
  const cache = createQuotaCache({ now: () => now, read: async () => { reads++; return expected() } })
  await cache.get()
  now += 540_000
  cache.observe([{ window: 'five_hour', percentUsed: 90, resetsAt: FIVE }])
  assert.deepEqual(await cache.get(), { observedAt: iso(now), windows: { five_hour: { percentUsed: 90, resetsAt: FIVE }, seven_day: { percentUsed: 17.5, resetsAt: SEVEN } } })
  assert.equal(reads, 1)
  now = OBS + 600_001
  assert.deepEqual(await cache.get(), expected())
  assert.equal(reads, 2)
})
test('an event replaces a no-plan-limits cached report with a partial reading', async () => {
  const cache = createQuotaCache({ now: () => OBS, read: async () => quotaFromUsage(NO_PLAN_USAGE, OBS) })
  await cache.get()
  cache.observe([{ window: 'five_hour', percentUsed: 90, resetsAt: FIVE }])
  assert.deepEqual(await cache.get(), { observedAt: iso(OBS), windows: { five_hour: { percentUsed: 90, resetsAt: FIVE } }, source: 'rate_limit_event' })
})
test('an aborted read is not cached', async () => {
  let reads = 0
  const cache = createQuotaCache({ now: () => OBS, read: async () => { if (++reads === 1) throw new DOMException('stopped', 'AbortError'); return expected() } })
  // Whether get propagates the abort or turns it into unreadable, it must reread.
  try { await cache.get() } catch (error) { assert.ok(error instanceof Error && error.name === 'AbortError') }
  assert.deepEqual(await cache.get(), expected())
  assert.equal(reads, 2)
})

test('invalidating a cached quota reading reads again inside the TTL', async () => {
  let reads = 0
  const cache = createQuotaCache({ now: () => OBS, read: async () => { reads++; return expected() } })
  await cache.get()
  await cache.get()
  assert.equal(reads, 1)
  const invalidate = Reflect.get(cache, 'invalidate')
  assert.equal(typeof invalidate, 'function', 'QuotaCache must expose invalidate()')
  invalidate.call(cache)
  assert.deepEqual(await cache.get(), expected())
  assert.equal(reads, 2)
})

// ro-2: get_usage without profile scope falls back to the attempt's stream events.
// Keep the current parser name; its planned contract returns an array.
const NO_PLAN_USAGE = { rate_limits_available: false, rate_limits: {} }
const UNIFIED = { type: 'rate_limit_event', rate_limit_info: {
  status: 'allowed', resetsAt: 1794315600, rateLimitType: 'five_hour',
  unifiedWindows: {
    five_hour: { utilization: 0.43, resetsAt: 1794315600, status: 'allowed' },
    seven_day: { utilization: 0.31, resetsAt: 1794682800, status: 'allowed' },
  },
} }
const unifiedEvents = (): QuotaEvent[] => [
  { window: 'five_hour', percentUsed: 43, resetsAt: iso(1794315600 * 1000) },
  { window: 'seven_day', percentUsed: 31, resetsAt: iso(1794682800 * 1000) },
]
const eventReading = (observedAt = OBS) => ({ observedAt: iso(observedAt), windows: {
  five_hour: { percentUsed: 43, resetsAt: iso(1794315600 * 1000) },
  seven_day: { percentUsed: 31, resetsAt: iso(1794682800 * 1000) },
}, source: 'rate_limit_event' })
const streamEvent = (info: object) => ({ type: 'rate_limit_event', rate_limit_info: info })

test('Claude events read both unifiedWindows', () => {
  for (const { resetsAt } of unifiedEvents()) assert.ok(Math.abs(Date.parse(resetsAt!) - OBS) < 400 * 86_400_000)
  assert.deepEqual(quotaFromRateLimitEvent(UNIFIED, OBS), unifiedEvents())
})
test('a bad unified window does not drop the other window', () => {
  assert.deepEqual(quotaFromRateLimitEvent(streamEvent({ unifiedWindows: {
    five_hour: { utilization: 1.3 }, seven_day: UNIFIED.rate_limit_info.unifiedWindows.seven_day,
  } }), OBS), [unifiedEvents()[1]])
})
for (const utilization of [undefined, null]) {
  test(`a rejected unified window with ${utilization} utilization means 100%`, () => {
    assert.deepEqual(quotaFromRateLimitEvent(streamEvent({ unifiedWindows: {
      five_hour: { status: 'rejected', utilization, resetsAt: Date.parse(FIVE) / 1000 },
    } }), OBS), [{ window: 'five_hour', percentUsed: 100, resetsAt: FIVE }])
  })
}
test('unifiedWindows ignores model-specific keys', () => {
  assert.deepEqual(quotaFromRateLimitEvent(streamEvent({ unifiedWindows: {
    ...UNIFIED.rate_limit_info.unifiedWindows, seven_day_opus: { utilization: 0.9 },
  } }), OBS), unifiedEvents())
})
test('unifiedWindows wins over top-level utilization', () => {
  assert.deepEqual(quotaFromRateLimitEvent({ ...UNIFIED, rate_limit_info: { ...UNIFIED.rate_limit_info, utilization: 0.9 } }, OBS), unifiedEvents())
})
test("cache falls back to the last attempt's event when get_usage has no plan limits", async () => {
  const cache = createQuotaCache({ now: () => OBS, read: async () => quotaFromUsage(NO_PLAN_USAGE, OBS) })
  assert.deepEqual(await cache.get(), { unreadable: 'no plan limits: API key, third-party provider or no profile scope' })
  cache.observe(unifiedEvents())
  assert.deepEqual(await cache.get(), eventReading())
})
const REFUSED = { unreadable: NO_PLAN_LIMITS }
test("cache falls back to the attempt's event when get_usage has no plan limits (again)", async () => {
  let now = OBS
  let reads = 0
  const cache = createQuotaCache({ ttlMs: 600_000, now: () => now, read: async () => { reads++; return REFUSED } })
  assert.deepEqual(await cache.get(), REFUSED)
  cache.observe(unifiedEvents())
  assert.deepEqual(await cache.get(), eventReading())
  now += 600_001
  assert.deepEqual(await cache.get(), eventReading(OBS))
  assert.equal(reads, 2)
})
test('a seeded event reading is used while get_usage has no plan limits', async () => {
  const cache = createQuotaCache({ now: () => OBS, read: async () => REFUSED, seed: { observedAt: OBS - 60_000, windows: { seven_day: { percentUsed: 77, resetsAt: SEVEN } } } })
  assert.deepEqual(await cache.get(), { observedAt: iso(OBS - 60_000), windows: { seven_day: { percentUsed: 77, resetsAt: SEVEN } }, source: 'rate_limit_event' })
})
test('the event reading survives the TTL and ages', async () => {
  let now = OBS
  let reads = 0
  const cache = createQuotaCache({ ttlMs: 600_000, now: () => now, read: async () => { reads++; return quotaFromUsage(NO_PLAN_USAGE, now) } })
  await cache.get()
  cache.observe(unifiedEvents())
  now += 600_001
  const reading = await cache.get()
  assert.equal(reads, 2)
  assert.deepEqual(reading, eventReading(OBS))
})
test('a readable get_usage answer wins over events', async () => {
  let reads = 0
  const cache = createQuotaCache({ now: () => OBS, read: async () => { reads++; return expected() } })
  cache.observe(unifiedEvents())
  assert.deepEqual(await cache.get(), expected())
  assert.equal(reads, 1)
})
test('another unreadable reason is not replaced by events', async () => {
  const cache = createQuotaCache({ now: () => OBS, read: async () => ({ unreadable: 'offline' }) })
  assert.deepEqual(await cache.get(), { unreadable: 'offline' })
  cache.observe(unifiedEvents())
  assert.deepEqual(await cache.get(), { unreadable: 'offline' })
})
test('invalidate keeps the event reading', async () => {
  let now = OBS
  let reads = 0
  const cache = createQuotaCache({ now: () => now, read: async () => { reads++; return quotaFromUsage(NO_PLAN_USAGE, now) } })
  await cache.get()
  cache.observe(unifiedEvents())
  now += 120_000
  cache.invalidate()
  const reading = await cache.get()
  assert.equal(reads, 2)
  assert.deepEqual(reading, eventReading(OBS))
})

// Structural options keep the tests compilable before the new cache hooks exist.
type Observation = { observedAt: number; windows: { five_hour?: { percentUsed: number; resetsAt?: string }; seven_day?: { percentUsed: number; resetsAt?: string } } }
test('observe persists and a new cache seeded from it reads the event after a restart', async () => {
  let saved: Observation | undefined
  const read = async () => ({ unreadable: NO_PLAN_LIMITS })
  const options = { now: () => OBS, read, persist: (value: Observation) => { saved = structuredClone(value) } }
  const cache = createQuotaCache(options)
  cache.observe([{ window: 'seven_day', percentUsed: 77 }])
  assert.deepEqual(saved, { observedAt: OBS, windows: { seven_day: { percentUsed: 77 } } })
  const seeded = { ...options, seed: saved }
  const restarted = createQuotaCache(seeded)
  assert.deepEqual(await restarted.get(), { observedAt: iso(OBS), windows: { seven_day: { percentUsed: 77 } }, source: 'rate_limit_event' })
})
test('a seeded window whose reset has passed is dropped', async () => {
  const options = { now: () => OBS, read: async () => ({ unreadable: NO_PLAN_LIMITS }), seed: {
    observedAt: OBS - 60_000, windows: { five_hour: { percentUsed: 99, resetsAt: iso(OBS) }, seven_day: { percentUsed: 77, resetsAt: SEVEN } },
  } }
  const cache = createQuotaCache(options)
  assert.deepEqual(await cache.get(), { observedAt: iso(OBS - 60_000), windows: { seven_day: { percentUsed: 77, resetsAt: SEVEN } }, source: 'rate_limit_event' })
})

const HALF_HOUR = 30 * 60_000
test('a probe runs when the reading is missing, and its events are the reading and are persisted', async () => {
  const saved: unknown[] = []
  let probes = 0
  const cache = createQuotaCache({ now: () => OBS, read: async () => REFUSED, persist: (o) => saved.push(o), probe: async () => { probes++; return unifiedEvents() } })
  assert.deepEqual(await cache.get(), eventReading())
  assert.equal(probes, 1)
  assert.equal(saved.length, 1)
})
test('a probe runs when the event reading is older than 30 minutes, not before', async () => {
  let now = OBS
  let probes = 0
  const fresh = [{ window: 'five_hour', percentUsed: 12 }] as QuotaEvent[]
  const cache = createQuotaCache({ ttlMs: 60_000, now: () => now, read: async () => REFUSED, seed: { observedAt: OBS - 60_000, windows: { seven_day: { percentUsed: 77, resetsAt: SEVEN } } }, probe: async () => { probes++; return fresh } })
  assert.equal('windows' in await cache.get(), true)
  now = OBS + HALF_HOUR - 120_000
  await cache.get()
  assert.equal(probes, 0, 'a reading under 30 minutes old is not probed')
  now = OBS + HALF_HOUR + 1000
  const reading = object(await cache.get())
  assert.equal(probes, 1)
  assert.deepEqual(object(reading.windows).five_hour, { percentUsed: 12 })
  assert.equal(reading.observedAt, iso(now))
})
test('a readable get_usage answer is never probed', async () => {
  let probes = 0
  const cache = createQuotaCache({ now: () => OBS, read: async () => expected(), probe: async () => { probes++; return unifiedEvents() } })
  assert.deepEqual(await cache.get(), expected())
  assert.equal(probes, 0)
})
test('a probe that fails or tells nothing leaves the Account unreadable, and is not repeated within 30 minutes', async () => {
  let now = OBS
  let probes = 0
  const cache = createQuotaCache({ ttlMs: 1000, now: () => now, read: async () => REFUSED, probe: async () => { if (++probes === 1) throw new Error('boom'); return [] } })
  assert.deepEqual(await cache.get(), REFUSED)
  now += 2000
  assert.deepEqual(await cache.get(), REFUSED)
  assert.equal(probes, 1)
  now = OBS + HALF_HOUR + 1
  assert.deepEqual(await cache.get(), REFUSED)
  assert.equal(probes, 2)
})
