import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { CLAUDE, CODEX, SPARE, assertConsistent, caller, fixture, seeded } from '../../../test-support/fixture.ts'
import type { WorkRecord } from '../src/record.ts'
import { summarize } from '../src/summary.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-slots-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let homes = 0
const newHome = () => { const path = join(dir, `home-${homes++}`); mkdirSync(path); return path }
const turn = () => new Promise((resolve) => setImmediate(resolve))
const turns = async (n = 20) => { for (let i = 0; i < n; i++) await turn() }
const types = (record: WorkRecord) => record.events.map((e) => (e.type === 'terminal' ? `terminal:${e.outcome}` : 'stepId' in e ? `${e.type}:${e.stepId}` : e.type))

test('Brainstorm: idea-a (Claude) and idea-b (Codex) are in execute at once', { timeout: 20_000 }, async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  try {
    const { id } = await host.submit(f.admission('brainstorm.yaml'))
    f.hold('idea-a')
    f.hold('idea-b')
    const running = host.run(id)
    await Promise.all([f.arrived('idea-a'), f.arrived('idea-b')])
    assert.deepEqual(types(host.view.get(id)!), ['admitted', 'dispatched:idea-a', 'dispatched:idea-b'])
    f.release('idea-a')
    f.release('idea-b')
    const done = await running
    assert.equal(done.state.status, 'succeeded')
    assert.deepEqual(done.events.filter((e) => e.type === 'dispatched').map((e) => e.type === 'dispatched' && e.selected), [CLAUDE, CODEX, CLAUDE])
    assertConsistent(f, id)
  } finally {
    await host.close()
  }
})

test('a synthesis step waits for both proposals', { timeout: 20_000 }, async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  try {
    const { id } = await host.submit(f.admission('brainstorm.yaml'))
    f.hold('idea-b')
    const running = host.run(id)
    await f.arrived('idea-b')
    await turns()
    assert.deepEqual(types(host.view.get(id)!), ['admitted', 'dispatched:idea-a', 'dispatched:idea-b', 'observed:idea-a'])
    assert.deepEqual(f.attempts, ['idea-a', 'idea-b'], 'the synthesis is not started with one proposal')
    f.release('idea-b')
    const done = await running
    assert.deepEqual(f.attempts.slice(2), ['synthesis'])
    assert.equal(done.state.status, 'succeeded')
    const synthesis = done.events.find((e) => e.type === 'dispatched' && e.stepId === 'synthesis')!
    assert.deepEqual(Object.keys(synthesis.type === 'dispatched' ? synthesis.inputs : {}).sort(), ['brief', 'proposal-a', 'proposal-b'])
    assertConsistent(f, id)
  } finally {
    await host.close()
  }
})

/** Two Brainstorms at once, idea-a held: how many idea-a attempts ran together. */
async function contended(slots: number | undefined) {
  const f = fixture({ slots })
  const host = await f.startHost(newHome())
  try {
    const a = await host.submit(f.admission('brainstorm.yaml'))
    const b = await host.submit(f.admission('brainstorm.yaml'))
    f.hold('idea-a')
    const runs = [host.run(a.id), host.run(b.id)]
    await f.arrived('idea-a')
    await turns()
    const together = f.peak[CLAUDE]
    f.release('idea-a')
    const done = await Promise.all(runs)
    for (const record of done) assert.equal(record.state.status, 'succeeded')
    assertConsistent(f, a.id)
    assertConsistent(f, b.id)
    return { together, peak: f.peak[CLAUDE] }
  } finally {
    await host.close()
  }
}

test('two Works on one Account never run two attempts at once with a limit of 1', { timeout: 20_000 }, async () => {
  assert.deepEqual(await contended(undefined), { together: 1, peak: 1 })
  assert.deepEqual(await contended(1), { together: 1, peak: 1 })
})

test('two Works on one Account run two attempts at once with a limit of 2', { timeout: 20_000 }, async () => {
  const f = fixture({ slots: 2 })
  const host = await f.startHost(newHome())
  try {
    const a = await host.submit(f.admission('brainstorm.yaml'))
    const b = await host.submit(f.admission('brainstorm.yaml'))
    f.hold('idea-a')
    const runs = [host.run(a.id), host.run(b.id)]
    await f.arrived('idea-a', 2)
    assert.equal(f.peak[CLAUDE], 2)
    f.release('idea-a')
    for (const record of await Promise.all(runs)) assert.equal(record.state.status, 'succeeded')
    assert.equal(f.peak[CLAUDE], 2, 'never more than the limit')
  } finally {
    await host.close()
  }
})

test('a waiting step goes in Work admission order when its slot frees', { timeout: 20_000 }, async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  try {
    const ids = [(await host.submit(f.admission('brainstorm.yaml'))).id, (await host.submit(f.admission('brainstorm.yaml'))).id, (await host.submit(f.admission('brainstorm.yaml'))).id]
    f.hold('idea-a')
    // Asked in the reverse order: the third Work holds the slot first.
    const runs = [host.run(ids[2]!), host.run(ids[1]!), host.run(ids[0]!)]
    await f.arrived('idea-a')
    f.release('idea-a')
    await Promise.all(runs)
    const first = (workId: string) => host.view.get(workId)!.events.find((e) => e.type === 'dispatched' && e.stepId === 'idea-a')!.at
    assert.ok(first(ids[2]!) <= first(ids[0]!) && first(ids[0]!) <= first(ids[1]!), 'after the first holder, Work 0 then Work 1')
  } finally {
    await host.close()
  }
})

test('a cancel while two attempts run records both, then one terminal event', { timeout: 20_000 }, async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  try {
    const { id } = await host.submit(f.admission('brainstorm.yaml'))
    f.hold('idea-a')
    f.hold('idea-b')
    const running = host.run(id)
    await Promise.all([f.arrived('idea-a'), f.arrived('idea-b')])
    assert.equal(await host.cancel(id, { caller, reason: 'stop' }), 'requested')
    f.release('idea-a')
    f.release('idea-b')
    const done = await running
    assert.deepEqual(types(done), ['admitted', 'dispatched:idea-a', 'dispatched:idea-b', 'observed:idea-a', 'observed:idea-b', 'terminal:cancelled'])
    assertConsistent(f, id)
  } finally {
    await host.close()
  }
})

test('a Host killed with two attempts in flight: both are lost, their slots are held until settled, and nothing is dispatched by itself', { timeout: 20_000 }, async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  const { id } = await first.submit(f.admission('brainstorm.yaml'))
  f.hold('idea-a')
  f.hold('idea-b')
  const running = first.run(id, { commandId: 'run-1' })
  await Promise.all([f.arrived('idea-a'), f.arrived('idea-b')])
  await first.close()
  f.release('idea-a')
  f.release('idea-b')
  await assert.rejects(running, /Host is closed/)

  const second = await f.startHost(home)
  try {
    const [a, b] = [second.view.get(id)!.state.steps['idea-a']!.attempts[0]!, second.view.get(id)!.state.steps['idea-b']!.attempts[0]!]
    assert.deepEqual(types(second.view.get(id)!), ['admitted', 'dispatched:idea-a', 'dispatched:idea-b', 'attempt-lost:idea-a', 'attempt-lost:idea-b'])
    assert.deepEqual(second.slots.uncertain(), [{ workId: id, stepId: 'idea-a', attemptId: a }, { workId: id, stepId: 'idea-b', attemptId: b }])
    await turns()
    assert.deepEqual(f.attempts, ['idea-a', 'idea-b'], 'nothing is dispatched by itself')

    // An explicit run waits: both Accounts' slots are held by attempts that may still run.
    const rerun = second.run(id, { commandId: 'run-2' })
    await turns(50)
    assert.deepEqual(f.attempts, ['idea-a', 'idea-b'], 'the held slots keep the Work waiting')
    // Another Work on the same Account waits too.
    const other = await second.submit(f.admission('brainstorm.yaml'))
    const otherRun = second.run(other.id)
    await turns(50)
    assert.deepEqual(f.attempts, ['idea-a', 'idea-b'])

    // Confirming idea-a's process gone frees the Claude Account only.
    f.hold('idea-a')
    f.gone(a)
    assert.deepEqual(await second.slots.settle(), [{ workId: id, stepId: 'idea-a', attemptId: a }])
    assert.deepEqual(second.slots.uncertain(), [{ workId: id, stepId: 'idea-b', attemptId: b }])
    await f.arrived('idea-a', 2)
    await turns(50)
    assert.equal(f.attempts.filter((s) => s === 'idea-a').length, 2, 'idea-a runs again, once: the Work that asked first takes the slot')
    assert.equal(f.attempts.filter((s) => s === 'idea-b').length, 1, 'idea-b waits for its Codex slot')

    f.gone(b)
    f.release('idea-a')
    await second.slots.settle()
    assert.deepEqual(second.slots.uncertain(), [])
    for (const record of await Promise.all([rerun, otherRun])) assert.equal(record.state.status, 'succeeded')
    assertConsistent(f, id)
    assertConsistent(f, other.id)
  } finally {
    await second.close()
  }
})

test('a lost attempt whose Worker cannot confirm it gone keeps its slot', { timeout: 20_000 }, async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  const { id } = await first.submit(f.admission('brainstorm.yaml'))
  f.hold('idea-a')
  const running = first.run(id)
  await f.arrived('idea-a')
  await first.close()
  f.release('idea-a')
  await assert.rejects(running, /Host is closed/)
  const second = await f.startHost(home)
  try {
    assert.deepEqual(await second.slots.settle(), [])
    assert.equal(second.slots.uncertain().length, 2)
  } finally {
    await second.close()
  }
})

test('a lost attempt confirmed gone at the next start frees its slot at once; one confirmed later is settled when its Work waits for the slot', { timeout: 20_000 }, async () => {
  const f = fixture()
  const home = newHome()
  const first = await f.startHost(home)
  const { id } = await first.submit(f.admission('brainstorm.yaml'))
  f.hold('idea-a')
  f.hold('idea-b')
  const running = first.run(id)
  await Promise.all([f.arrived('idea-a'), f.arrived('idea-b')])
  await first.close()
  f.release('idea-a')
  f.release('idea-b')
  await assert.rejects(running, /Host is closed/)
  const [a, b] = [first.view.get(id)!.state.steps['idea-a']!.attempts[0]!, first.view.get(id)!.state.steps['idea-b']!.attempts[0]!]

  f.gone(a)
  const second = await f.startHost(home)
  try {
    assert.deepEqual(second.slots.uncertain(), [{ workId: id, stepId: 'idea-b', attemptId: b }], 'idea-a was confirmed gone at start')
    f.hold('idea-a')
    const rerun = second.run(id)
    await f.arrived('idea-a', 2)
    await turns(50)
    assert.equal(f.attempts.filter((s) => s === 'idea-b').length, 1, 'idea-b waits for its slot')
    f.gone(b)
    // Nobody calls settle: the waiting Work asks again when its own attempt ends.
    f.release('idea-a')
    assert.equal((await rerun).state.status, 'succeeded')
    assert.deepEqual(second.slots.uncertain(), [])
  } finally {
    await second.close()
  }
})

for (let seed = 1; seed <= 50; seed++) {
  test(`seed ${seed}: three concurrent Brainstorms with random delays replay exactly, losing and repeating no event`, { timeout: 30_000 }, async () => {
    const f = fixture({ seed, slots: 1 + (seed % 2) })
    const host = await f.startHost(newHome())
    try {
      const random = seeded(seed + 500)
      const ids: string[] = []
      for (let n = 0; n < 3; n++) ids.push((await host.submit(f.admission('brainstorm.yaml'))).id)
      const runs: Promise<WorkRecord>[] = []
      for (const id of ids) {
        for (let n = Math.floor(random() * 6); n > 0; n--) await turn()
        runs.push(host.run(id))
      }
      for (const record of await Promise.all(runs)) {
        assert.equal(record.state.status, 'succeeded')
        assert.equal(record.events.length, 8, 'admitted, three dispatched, three observed, one terminal')
        assert.deepEqual(record.events.filter((e) => e.type === 'dispatched').map((e) => e.type === 'dispatched' && e.stepId).sort(), ['idea-a', 'idea-b', 'synthesis'])
        assertConsistent(f, record.id)
      }
      assert.ok((f.peak[CLAUDE] ?? 0) <= 1 + (seed % 2) && (f.peak[CODEX] ?? 0) <= 1 + (seed % 2), 'never more than the limit')
    } finally {
      await host.close()
    }
  })
}

test('three Works reach their checks at once: only two run until one finishes, and the third shows as waiting for a check slot', { timeout: 20_000 }, async () => {
  const f = fixture({ checks: 2 })
  const host = await f.startHost(newHome())
  try {
    const ids = [(await host.submit(f.admission('code-checks.yaml'))).id, (await host.submit(f.admission('code-checks.yaml'))).id, (await host.submit(f.admission('code-checks.yaml'))).id]
    f.hold('checks')
    const runs = ids.map((id) => host.run(id))
    await f.arrived('checks', 2)
    await turns(50)
    assert.equal(f.checkAttempts.length, 2, 'the third check does not start')
    const waiting = ids.filter((id) => host.view.live(id).some((a) => a.waiting === 'a check slot'))
    assert.equal(waiting.length, 1)
    assert.equal(host.view.get(waiting[0]!)!.events.some((e) => e.type === 'dispatched'), false, 'a waiting check is not dispatched')
    f.release('checks')
    for (const record of await Promise.all(runs)) assert.equal(record.state.status, 'succeeded')
    assert.equal(f.checkAttempts.length, 3)
    assert.equal(f.checkPeak(), 2, 'never more than the limit')
    assert.deepEqual(ids.flatMap((id) => host.view.live(id)), [])
    for (const id of ids) assertConsistent(f, id)
  } finally {
    await host.close()
  }
})

test('a lost check keeps its check slot until its process is confirmed gone, then the slot is freed', { timeout: 20_000 }, async () => {
  const f = fixture({ checks: 1 })
  const home = newHome()
  const first = await f.startHost(home)
  const { id } = await first.submit(f.admission('code-checks.yaml'))
  f.hold('checks')
  const running = first.run(id)
  await f.arrived('checks')
  await first.close()
  f.release('checks')
  await assert.rejects(running, /Host is closed/)

  const second = await f.startHost(home)
  try {
    const lost = second.slots.uncertain()
    assert.equal(lost.length, 1)
    assert.equal(lost[0]!.stepId, 'checks')
    const other = await second.submit(f.admission('code-checks.yaml'))
    const otherRun = second.run(other.id)
    await turns(50)
    assert.equal(f.checkAttempts.length, 1, 'the lost check still holds the only slot')
    assert.equal(second.view.live(other.id)[0]?.waiting, 'a check slot')
    assert.deepEqual(await second.slots.settle(), [], 'not confirmed gone: the slot stays held')
    f.gone(lost[0]!.attemptId)
    assert.deepEqual(await second.slots.settle(), lost)
    assert.equal((await otherRun).state.status, 'succeeded', 'the waiting Work takes the freed slot')
    assert.deepEqual(second.slots.uncertain(), [])
    assert.equal(f.checkAttempts.length, 2)
  } finally {
    await second.close()
  }
})

test('a step whose first capable Account is full goes to the next capable Account with a free slot, and the record says why', { timeout: 20_000 }, async () => {
  const f = fixture({ spare: true })
  const host = await f.startHost(newHome())
  try {
    const a = await host.submit(f.admission('brainstorm.yaml'))
    const b = await host.submit(f.admission('brainstorm.yaml'))
    f.hold('idea-a')
    const runs = [host.run(a.id), host.run(b.id)]
    await f.arrived('idea-a', 2)
    const selected = [a.id, b.id].map((id) => host.view.get(id)!.events.find((e) => e.type === 'dispatched' && e.stepId === 'idea-a'))
    assert.deepEqual(selected.map((e) => e?.type === 'dispatched' && e.selected), [CLAUDE, SPARE])
    const second = selected[1]
    assert.ok(second?.type === 'dispatched' && second.candidates.find((c) => c.ref === CLAUDE)?.reason.includes('no free slot'))
    f.release('idea-a')
    for (const record of await Promise.all(runs)) assert.equal(record.state.status, 'succeeded')
  } finally {
    await host.close()
  }
})

test('a step waits when every capable Account is full; the time it waited is recorded and summed by the report', { timeout: 20_000 }, async () => {
  const f = fixture()
  const host = await f.startHost(newHome())
  try {
    const a = await host.submit(f.admission('brainstorm.yaml'))
    const b = await host.submit(f.admission('brainstorm.yaml'))
    f.hold('idea-a')
    const runs = [host.run(a.id), host.run(b.id)]
    await f.arrived('idea-a')
    await turns()
    await new Promise((resolve) => setTimeout(resolve, 60))
    f.release('idea-a')
    await Promise.all(runs)
    const waited = (id: string) => host.view.get(id)!.events.flatMap((e) => (e.type === 'dispatched' && e.waitedMs !== undefined ? [e.waitedMs] : []))
    assert.deepEqual(waited(a.id), [], 'the first Work found a free slot at once')
    assert.ok(waited(b.id).some((ms) => ms >= 50), `the second Work's waiting is recorded: ${waited(b.id)}`)
    assert.ok(summarize(host.view.get(b.id)!).waitedForSlotMs >= 50)
    assert.equal(summarize(host.view.get(a.id)!).waitedForSlotMs, 0)
  } finally {
    await host.close()
  }
})
