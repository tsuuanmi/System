import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkError } from '../src/errors.ts'
import { ItemGate, type ClaimTable } from '../src/gate.ts'
import { parseStatus } from '../src/status-parse.ts'
import { fold, type Claim, type WorkEvent, type WorkRecord } from '../src/record.ts'

/** The gate over a fake STATUS.md reader and a fake record list: no git repository anywhere. */
const REPO = '/repo'
const caller = (operatorId: string) => ({ type: 'agent', operatorId }) as const
const LINES = ['# Status', '', '- [x] a-1 Done', '- [ ] a-2 Ready (after: a-1)', '- [ ] a-3 Blocked (after: a-2)', '- [ ] a-4 Loop (after: a-5)', '- [ ] a-5 Loop (after: a-4)', ''].join('\n')

function memoryClaims(): ClaimTable {
  const rows = new Map<string, Claim>()
  return { get: (key) => rows.get(key), put: async (key, value) => { rows.set(key, value) }, delete: async (key) => rows.delete(key), keys: () => rows.keys() }
}

function setup(text: string | Error = LINES) {
  const records: WorkRecord[] = []
  const reads: string[] = []
  const gate = new ItemGate({
    records: () => records,
    claims: memoryClaims(),
    readStatus: async (path) => {
      reads.push(path)
      if (text instanceof Error) throw text
      return { repository: REPO, commit: 'c0ffee'.repeat(2), ref: 'dev', note: 'read dev', ...parseStatus(text) }
    },
  })
  /** A running Work for an Item, as its record is after one dispatch. */
  const running = (item: string, id = `work:${records.length + 1}`): WorkRecord => {
    const events: WorkEvent[] = [
      { type: 'admitted', seq: 0, at: '2026-11-09T00:00:00.000Z', caller: { type: 'human', operatorId: 'tan' }, specId: 'sha256:' + 'a'.repeat(64), item: { id: item, repository: REPO }, criteria: {}, verifiers: {}, source: { kind: 'direct-task' } } as WorkEvent,
      { type: 'dispatched', seq: 1, at: '2026-11-09T00:01:00.000Z', stepId: 'task', attemptId: 'a:1', executor: 'worker', capability: 'code-write', selected: 'fake/claude', candidates: [], inputs: {} } as WorkEvent,
    ]
    const record = { id, events, state: fold(['task'], events) } as WorkRecord
    records.push(record)
    return record
  }
  const decide = async (item: string, force?: boolean) => (await gate.deciding({ id: item, repository: REPO }, force))?.({ id: item, repository: REPO })
  return { gate, records, reads, running, decide }
}

test('gate: a Ready Item is decided with its note; the note opens with its line', async () => {
  const { decide } = setup()
  const decision = await decide('a-2')
  assert.match(decision!.note, /^\[ \] a-2 Ready - todo: nobody\n/)
})

test('gate: a Blocked Item is refused naming what blocks it, a cycle says so; force goes on', async () => {
  const { decide } = setup()
  await assert.rejects(decide('a-3'), (error: Error) => error instanceof WorkError && /Item a-3 is blocked by a-2; to run it on purpose, give force \(--force\)$/.test(error.message))
  await assert.rejects(decide('a-4'), /blocked: cycle/)
  assert.ok(await decide('a-3', true))
})

test('gate: an Item with a running or held Work is busy: refused naming the Work and its Account, unless force', async () => {
  const { decide, running } = setup()
  const work = running('a-2')
  await assert.rejects(decide('a-2'), (error: Error) => error.message === `Item a-2 already has Work ${work.id} (running, fake/claude); to run another on purpose, give force (--force)`)
  assert.ok(await decide('a-2', true))
  assert.ok(await decide('a-1'), 'another Item is not affected')
})

test('gate: an unreadable STATUS.md refuses an Item, naming the repository; force goes on, without a line in the note', async () => {
  const { decide } = setup(new Error('not a git repository'))
  await assert.rejects(decide('a-2'), (error: Error) => error.message === `STATUS.md of ${REPO} could not be read: not a git repository; to go on without it, give force`)
  assert.match((await decide('a-2', true))!.note, /not in STATUS\.md/)
})

test('gate: an Item with no line is refused, unless force', async () => {
  const { decide } = setup()
  await assert.rejects(decide('a-9'), (error: Error) => error.message === `Item a-9 has no line in STATUS.md on dev of ${REPO}; to go on without it, give force`)
  assert.ok(await decide('a-9', true))
})

test('gate: a Task that names no Item, or an Item without a repository, is not read or checked', async () => {
  const { gate, reads } = setup()
  assert.equal(await gate.deciding(undefined), undefined)
  assert.ok(await gate.deciding({ id: 'a-3' }))
  assert.deepEqual(reads, [])
})

test('gate: with force the STATUS.md is still read once for the note; the read happens before, not while, the decision', async () => {
  const { gate, reads } = setup()
  const decide = await gate.deciding({ id: 'a-2', repository: REPO }, true)
  assert.deepEqual(reads, [REPO])
  decide!({ id: 'a-2', repository: REPO })
  decide!({ id: 'a-3', repository: REPO })
  assert.deepEqual(reads, [REPO], 'deciding reads nothing')
})

test('gate: a claim is refused for another session unless force, for a busy Item always; a Work takes it over', async () => {
  const { gate, running, decide } = setup()
  const first = await gate.claim(REPO, 'a-2', caller('session-a'))
  assert.equal(first.who, 'session-a')
  assert.deepEqual(gate.claims(), [first])
  const again = await gate.claim(REPO, 'a-2', caller('session-a'))
  await assert.rejects(gate.claim(REPO, 'a-2', caller('session-b')), (error: Error) => error.message === `Item a-2 is claimed by session-a since ${again.at}; to take it over on purpose, give force (--force)`)
  assert.equal((await gate.claim(REPO, 'a-2', caller('session-b'), true)).who, 'session-b')
  const decision = await decide('a-2')
  await decision!.taken()
  assert.deepEqual(gate.claims(), [])
  const work = running('a-2')
  await assert.rejects(gate.claim(REPO, 'a-2', caller('session-a'), true), (error: Error) => error.message === `Item a-2 already has Work ${work.id} (running, fake/claude)`)
})

test('gate: item.claim needs a readable STATUS.md with a line for the Item; force goes on and names the repository as it is', async () => {
  const { gate } = setup()
  assert.equal(await gate.claimTarget(REPO, 'a-2'), REPO)
  await assert.rejects(gate.claimTarget(REPO, 'a-9'), /Item a-9 has no line in STATUS\.md on dev/)
  assert.equal(await gate.claimTarget('/elsewhere', 'a-9', true), REPO, 'force: the top level of a readable repository')
  const gone = setup(new Error('boom'))
  await assert.rejects(gone.gate.claimTarget('/x', 'a-2'), /STATUS\.md of \/x could not be read: boom; to go on without it, give force/)
  assert.equal(await gone.gate.claimTarget('/x', 'a-2', true), '/x')
})

test('gate: task.new refuses a Blocked Item with its own wording, and does not mind busy; force goes on', async () => {
  const { gate, running } = setup()
  running('a-2')
  await gate.checkTask('a-2', REPO)
  await assert.rejects(gate.checkTask('a-3', REPO), (error: Error) => error.message === 'Item a-3 is blocked by a-2; to store its Task on purpose, give force')
  await gate.checkTask('a-3', REPO, true)
  await gate.checkTask(undefined, REPO)
})
