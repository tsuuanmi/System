import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AccountAdmission, type Clock } from '../src/admission.ts'
import { Capabilities, type WorkerPort } from '../src/registry.ts'

const DAY = 86_400_000
const START = Date.parse('2026-11-10T22:00:00Z')

/** A clock whose timers fire only when `advance` passes them. */
function fakeClock(start = START) {
  let now = start
  let next = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    now: () => now,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimer: (id) => { timers.delete(id as number) },
  }
  return {
    clock, timers,
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    },
  }
}

const window = (five: number, resetsAt?: string) => ({ observedAt: '2026-11-10T00:00:00Z', windows: { five_hour: { percentUsed: five, ...(resetsAt ? { resetsAt } : {}) } } })
function setup(refs: Record<string, number | undefined>, options: { history?: { ref: string; at: number }[]; start?: number } = {}) {
  const capabilities = new Capabilities()
  for (const ref of Object.keys(refs)) capabilities.registerWorker({ ref, capabilities: ['research'], run: async () => undefined } as unknown as WorkerPort)
  const f = fakeClock(options.start)
  const wakes: number[] = []
  const admission = new AccountAdmission({ clock: f.clock, retryMs: 1_000, history: () => options.history ?? [] })
  admission.attemptsToday() // seeded now, as the first dispatch does; later attempts are counted
  admission.onWake(() => wakes.push(f.clock.now()))
  const readings = new Map(Object.entries(refs).filter(([, v]) => v !== undefined).map(([ref, v]) => [ref, window(v!)]))
  const route = (key = 'w/s', extra: { only?: string; readings?: typeof readings } = {}) =>
    admission.route(capabilities, { workId: 'w', stepId: 's', key }, ['research'], extra.only, () => true, extra.readings ?? readings)
  return { admission, capabilities, route, readings, wakes, ...f }
}

test('an Account at its Ceiling is skipped', () => {
  const f = setup({ A: 85, B: 50 })
  const route = f.route()
  assert.equal(route.selected?.ref, 'B')
  assert.match(route.candidates.find((c) => c.ref === 'A')!.reason, /over|ceiling/i)
})

test('every Account at its Ceiling waits, and the wake-up comes at the retry interval', () => {
  const f = setup({ A: 85 })
  assert.deepEqual(f.route().quotaWait, {})
  assert.equal(f.admission.waiting('w').length, 1)
  f.advance(999)
  assert.equal(f.wakes.length, 0)
  f.advance(1)
  assert.equal(f.wakes.length, 1)
  assert.equal(f.admission.waiting('w').length, 0)
})

test('Headroom ordering: the most headroom wins, ties go to the fewest attempts today', () => {
  assert.equal(setup({ A: 70, B: 10 }).route().selected?.ref, 'B')
  const f = setup({ A: 40, B: 40 })
  f.admission.count('A')
  assert.equal(f.route().selected?.ref, 'B')
})

test('a limited Account is skipped until its reset, then a wake-up frees it', () => {
  const f = setup({ A: undefined })
  f.admission.limit('A', f.clock.now() + 5_000)
  const route = f.route()
  assert.equal(route.selected, undefined)
  assert.deepEqual(route.quotaWait, {})
  assert.match(route.candidates[0]!.reason, /^limited:/)
  f.advance(1_000)
  assert.equal(f.wakes.length, 1)
  assert.equal(f.route().selected, undefined, 'still limited before the reset')
  f.advance(4_000)
  assert.equal(f.route().selected?.ref, 'A', 'free again at the reset')
})

test('a fresh readable reading is believed over the record of a limit', () => {
  const f = setup({ A: 10 })
  f.admission.limit('A', f.clock.now() + 5_000)
  assert.equal(f.route().selected?.ref, 'A')
})

test('a quota wait wakes at a known reset sooner than the retry interval', () => {
  const f = setup({ A: 90 })
  const resetsAt = new Date(f.clock.now() + 300).toISOString()
  f.route('w/s', { readings: new Map([['A', window(90, resetsAt)]]) })
  f.advance(300)
  assert.equal(f.wakes.length, 1)
})

test('the wait keeps its start across routes and is dropped by stop', () => {
  const f = setup({ A: 90 })
  f.route()
  const since = f.admission.waiting('w')[0]!.since
  f.advance(500)
  f.route()
  assert.equal(f.admission.waiting('w')[0]!.since, since)
  assert.equal(f.admission.waitingSince('w/s'), since)
  f.admission.stop('w/s')
  assert.equal(f.admission.waiting('w').length, 0)
  assert.equal(f.timers.size, 0)
  f.route()
  f.admission.stopWork('w')
  assert.equal(f.timers.size, 0)
})

test("today's count is seeded from history once, then kept as attempts are dispatched", () => {
  const f = setup({ A: 40, B: 40 }, { history: [{ ref: 'A', at: START - 1000 }, { ref: 'A', at: START - 2000 }, { ref: 'B', at: START - DAY * 2 }] })
  assert.deepEqual([...f.admission.attemptsToday()], [['A', 2]])
  f.admission.count('B')
  f.admission.count('B')
  f.admission.count('B')
  assert.deepEqual([...f.admission.attemptsToday()].sort(), [['A', 2], ['B', 3]])
})

test("today's count rolls over at the day boundary", () => {
  const f = setup({ A: 40, B: 40 })
  f.admission.count('A')
  assert.equal(f.route().selected?.ref, 'B')
  f.advance(2 * 3_600_000 - 1)
  assert.equal(f.admission.attemptsToday().get('A'), 1)
  f.advance(1)
  assert.equal(f.admission.attemptsToday().get('A'), undefined)
  assert.equal(f.route().selected?.ref, 'A', 'registration order again: the new day starts at zero')
})
