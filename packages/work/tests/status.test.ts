import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { memoryWorkTable } from '../../../test-support/memory.ts'
import { WorkController, type SpecStore } from '../src/controller.ts'
import type { Task } from '../src/kinds.ts'
import { fold, type WorkEvent, type WorkRecord } from '../src/record.ts'
import { Capabilities, type WorkerRequest } from '../src/registry.ts'
import { itemLines, parseStatus, readStatus, workStatus } from '../src/status.ts'
import { directTask, type ResolvedSpec } from '../src/workflow.ts'

const caller = { type: 'human', operatorId: 'tan' } as const
const id = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

const STATUS = [
  '# Status', '', 'Aim: A durable work control plane.', 'It runs Works.', '',
  '- [x] df-1 Drop Goals', '- [ ] df-3 The status of a project', '- [ ] df-4 The MCP instructions', '',
].join('\n')
const TICKED = STATUS.replace('- [ ] df-3', '- [x] df-3')

test('STATUS.md is parsed leniently: the aim, the Items, and a one-line reason per malformed line', () => {
  const parsed = parseStatus(STATUS)
  assert.deepEqual(parsed.aim, ['A durable work control plane.', 'It runs Works.'])
  assert.deepEqual(parsed.items, [
    { id: 'df-1', title: 'Drop Goals', done: true },
    { id: 'df-3', title: 'The status of a project', done: false },
    { id: 'df-4', title: 'The MCP instructions', done: false },
  ])
  assert.deepEqual(parsed.problems, [])

  const bad = parseStatus(['# S', 'Aim: x', '- [ ] Df-3 upper case', '- [ ] df-3 ok', '- [ ] df-3 twice', '- [?] df-5 odd box', '- just a bullet', '- [x] nonumber title', '- [ ] df-9', 'prose is fine'].join('\n'))
  assert.deepEqual(bad.items.map((i) => i.id), ['df-3', 'df-9'])
  assert.equal(bad.problems.length, 6)
  assert.ok(bad.problems.every((p) => !p.includes('\n')))
  assert.match(bad.problems[0]!, /^line 3: .*Df-3/)
  assert.match(bad.problems[1]!, /^line 5: .*df-3/)
  assert.match(bad.problems[2]!, /^line 6:/)
  assert.match(bad.problems[3]!, /^line 7:/)
  assert.match(bad.problems[4]!, /^line 8: .*nonumber/)
  assert.match(bad.problems[5]!, /^line 9: .*title/)

  assert.deepEqual(parseStatus('').problems, ['no Aim: line'])
  assert.match(parseStatus(`Aim: x\n${'\n'.repeat(120)}`).problems.join(), /lines/)
})

/** A repository whose `dev` tip says `onDev`, with a working tree that says `workingTree`. */
function repository(onDev: string, workingTree = onDev): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'system-status-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'dev')
  writeFileSync(join(dir, 'STATUS.md'), onDev)
  git('add', '.')
  git('commit', '-qm', 'status')
  writeFileSync(join(dir, 'STATUS.md'), workingTree)
  return dir
}

test('STATUS.md is read from the dev tip, not the working tree; a repository without one says so', async () => {
  const dir = repository(STATUS, TICKED)
  const read = await readStatus(dir)
  assert.equal(read.repository, dir)
  assert.equal(read.items.find((i) => i.id === 'df-3')!.done, false)

  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'system-status-none-')))
  execFileSync('git', ['-C', empty, 'init', '-q', '-b', 'dev'])
  execFileSync('git', ['-C', empty, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x'])
  const absent = await readStatus(empty)
  assert.deepEqual(absent.items, [])
  assert.match(absent.problems[0]!, /no STATUS\.md on dev/)
})

test('STATUS.md is read from origin/dev when it exists, though the local dev lacks it; the note says which and does not fetch', async () => {
  const dir = repository(STATUS)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
  const remote = git('rev-parse', 'HEAD').toString().trim()
  git('rm', '-q', '--cached', 'STATUS.md')
  git('commit', '-qm', 'local dev without STATUS.md')
  git('update-ref', 'refs/remotes/origin/dev', remote)
  const read = await readStatus(dir)
  assert.equal(read.ref, 'origin/dev')
  assert.equal(read.commit, remote)
  assert.deepEqual(read.items.map((i) => i.id), ['df-1', 'df-3', 'df-4'])
  assert.match(read.note, /^read origin\/dev \(.*not fetched/)

  git('update-ref', '-d', 'refs/remotes/origin/dev')
  const local = await readStatus(dir)
  assert.equal(local.ref, 'dev')
  assert.match(local.problems[0]!, /no STATUS\.md on dev/)
  assert.match(local.note, /^read dev \(/)
})

const CHANGE = id('a change')
const COMMIT = 'c'.repeat(40)
interface Stored { task: Task; repository?: string; note?: string }

function memory(): SpecStore & { stored: Set<string>; tasks: Map<string, Stored> } {
  const specs = new Map<string, ResolvedSpec>()
  const stored = new Set<string>()
  const tasks = new Map<string, Stored>()
  return {
    stored,
    tasks,
    unchangedBase: () => undefined,
    commitOf: (artifactId) => (artifactId === CHANGE ? COMMIT : undefined),
    kindOf: (artifactId) => (tasks.has(artifactId) ? 'task' : specs.has(artifactId) ? 'workflow-spec' : stored.has(artifactId) ? 'output' : undefined),
    async putVerdict(verdict) { const v = id(JSON.stringify(verdict)); stored.add(v); return v },
    async putSpec(spec) { const s = id(JSON.stringify(spec)); specs.set(s, structuredClone(spec)); stored.add(s); return s },
    getSpec: (specId) => structuredClone(specs.get(specId)),
    exists: (artifactId) => stored.has(artifactId),
    taskOf: (taskId) => tasks.get(taskId),
    async withNote(taskId, note) {
      const old = tasks.get(taskId)!
      const noted = id(`note ${note}`)
      stored.add(noted)
      const next = id(`${taskId} ${note}`)
      tasks.set(next, { ...old, task: { ...old.task, context: [...(old.task.context ?? []), noted] }, note })
      stored.add(next)
      return next
    },
  }
}

function setup() {
  const table = memoryWorkTable()
  const specs = memory()
  const capabilities = new Capabilities()
  const requests: WorkerRequest[] = []
  let gate: Promise<void> | undefined
  capabilities.registerWorker({
    ref: 'fake/claude', capabilities: ['code-write'],
    async run(request) {
      requests.push(request)
      request.progress?.({ turns: 3, lastTool: 'Edit', tokens: 1200 })
      await gate
      const outputs = Object.fromEntries(request.outputs.map((slot) => { const out = id(`${request.attemptId}/${slot}`); specs.stored.add(out); return [slot, out] }))
      return { status: 'succeeded', outputs }
    },
  })
  const controller = new WorkController(table, specs, capabilities)
  /** A stored Task over `repository`, naming `item` when given: the Tasks stored before Items have none. */
  const task = (repository: string, item?: string, instructions = 'do it'): string => {
    const base = id(`base ${repository}`)
    specs.stored.add(base)
    const taskId = id(`task ${instructions} ${repository} ${item}`)
    specs.tasks.set(taskId, { task: { instructions, base, ...(item ? { item } : {}) }, repository })
    specs.stored.add(taskId)
    return taskId
  }
  const admit = (input: string, force?: boolean) => controller.admit({ spec: directTask(['code-write'], true, capabilities.available()), input, caller, source: { kind: 'direct-task' }, ...(force ? { force } : {}) })
  const hold = () => {
    let open!: () => void
    gate = new Promise<void>((resolve) => { open = resolve })
    return () => { gate = undefined; open() }
  }
  return { controller, table, specs, requests, task, admit, hold }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('each state: done from dev, doing from a running Work with its live progress, todo is nobody', async () => {
  const dir = repository(STATUS)
  const { controller, task, admit, hold } = setup()
  const status = await readStatus(dir)
  const lines = (filter?: { state?: 'todo' | 'doing' | 'done'; item?: string }) => itemLines(status, dir, controller.list(), (workId) => controller.live(workId), filter)
  assert.deepEqual(lines(), [
    '[x] df-1 Drop Goals - done',
    '[ ] df-3 The status of a project - todo: nobody',
    '[ ] df-4 The MCP instructions - todo: nobody',
  ])

  const release = hold()
  const work = await admit(task(dir, 'df-3'))
  // Admitted and never run: still doing (it blocks the Item), but said not to be running.
  assert.equal(lines()[1], `[ ] df-3 The status of a project - doing: ${work.id} admitted, not running since ${work.events[0]!.at}`)
  assert.equal(workStatus(controller.get(work.id)!), 'admitted, not running')
  const running = controller.run(work.id)
  await settle()
  assert.equal(lines()[1], `[ ] df-3 The status of a project - doing: ${work.id} step task on fake/claude since ${work.events[0]!.at}; turns 3, last tool Edit, 1200 tokens`)
  assert.equal(lines().join('\n'), lines().join('\n'), 'the same records give the same text')
  assert.equal(lines({ state: 'doing' }).length, 1)
  assert.deepEqual(lines({ state: 'done' }), ['[x] df-1 Drop Goals - done'])
  assert.equal(lines({ state: 'todo' }).length, 1)
  assert.match(lines({ item: 'df-3' })[0]!, /doing/)
  assert.match(lines({ item: 'df-9' })[0]!, /^df-9 .*not in STATUS\.md/)
  release()
  const done = await running
  assert.equal(done.state.status, 'succeeded')

  // Finished and merged: dev's STATUS.md ticks the Item; the last Work and its Artifact are named.
  const merged = await readStatus(repository(TICKED))
  assert.equal(
    itemLines(merged, dir, controller.list(), () => [], { item: 'df-3' })[0],
    `[x] df-3 The status of a project - done; last ${work.id}, ${Object.values(done.state.results).join(', ')}`,
  )
})

test('a held Work is doing, with why it is held, and its Account', async () => {
  const dir = repository(STATUS)
  const { controller, table, task, admit } = setup()
  const work = await admit(task(dir, 'df-3'))
  const events: WorkEvent[] = [
    ...work.events,
    { type: 'dispatched', seq: 1, at: '2026-11-09T01:00:00.000Z', stepId: 'task', attemptId: 'attempt:1', executor: 'worker', capability: 'code-write', selected: 'fake/claude', candidates: [], inputs: {} },
    { type: 'terminal', seq: 2, at: '2026-11-09T01:05:00.000Z', outcome: 'held', reason: 'step publish awaits an operator decision', results: {}, awaiting: 'publish' },
  ]
  const held: WorkRecord = { ...work, events, state: fold(['task'], events) }
  await table.put(work.id, held)
  const status = await readStatus(dir)
  assert.equal(itemLines(status, dir, controller.list(), () => [], { item: 'df-3' })[0], `[ ] df-3 The status of a project - doing: ${work.id} step task on fake/claude since ${work.events[0]!.at}; held: step publish awaits an operator decision`)
  await assert.rejects(admit(task(dir, 'df-3', 'again')), (error: Error) => error.message.includes(work.id) && error.message.includes('held') && error.message.includes('fake/claude'))
})

test('a second Work for an Item with a running Work is refused, naming it and its Account; force allows it', async () => {
  const dir = repository(STATUS)
  const { controller, task, admit, hold } = setup()
  const release = hold()
  const first = await admit(task(dir, 'df-3'))
  const running = controller.run(first.id)
  await settle()
  await assert.rejects(admit(task(dir, 'df-3', 'again')), (error: Error) => error.message.includes(first.id) && error.message.includes('fake/claude') && error.message.includes('force') && !error.message.includes('\n'))
  // Another Item, another repository, and a Task that names no Item are not affected.
  await admit(task(dir, 'df-4'))
  await admit(task(dir))
  await admit(task(realpathSync(tmpdir()), 'df-3'))
  const forced = await admit(task(dir, 'df-3', 'again'), true)
  assert.equal(forced.state.status, 'running')
  release()
  await running
  assert.equal((await controller.run(forced.id)).state.status, 'succeeded')
  // Both are over: the Item is free again.
  assert.equal((await admit(task(dir, 'df-3', 'third'))).state.status, 'running')
})

test('the Worker of a step that reads the Task also gets the Item\'s line and the earlier Works of the Item', async () => {
  const dir = repository(STATUS)
  const { controller, specs, requests, task, admit } = setup()
  const first = await controller.run((await admit(task(dir, 'df-3'))).id)
  assert.equal(first.state.status, 'succeeded')
  const input = task(dir, 'df-3', 'carry on')
  const second = await admit(input)
  assert.notEqual(second.state.input, input, 'the Work reads the Task with the context added')
  const read = specs.tasks.get(second.state.input!)!
  assert.equal(read.task.item, 'df-3')
  assert.equal(read.task.instructions, 'carry on')
  assert.equal(read.task.context!.length, 1)
  assert.match(read.note!, /^\[ \] df-3 The status of a project - todo: nobody$/m)
  assert.ok(read.note!.includes(`${first.id} succeeded: ${Object.values(first.state.results).join(', ')}`), read.note)
  assert.ok(!read.note!.includes(second.id))
  await controller.run(second.id)
  assert.equal(requests.at(-1)!.inputs.input, second.state.input, 'the step is dispatched with that Task')
})

test('a failed earlier Work is named with its reason', async () => {
  const dir = repository(STATUS)
  const { controller, table, specs, task, admit } = setup()
  const first = await admit(task(dir, 'df-3'))
  const events: WorkEvent[] = [...first.events, { type: 'terminal', seq: 1, at: '2026-11-09T01:05:00.000Z', outcome: 'failed', reason: 'step task failed', results: {} }]
  await table.put(first.id, { ...first, events, state: fold(['task'], events) })
  const second = await admit(task(dir, 'df-3', 'again'))
  assert.match(specs.tasks.get(second.state.input!)!.note!, new RegExp(`${first.id} failed: step task failed`))
  void controller
})

test('an earlier failed Work gives its Task, change and commit, and the failing check\'s reason and evidence', async () => {
  const dir = repository(STATUS)
  const { table, specs, task, admit } = setup()
  const first = await admit(task(dir, 'df-3', 'make it'))
  const evidence = id('evidence')
  const reason = 'publish needs a passing verdict on its subject: checks.checks=fail (unit: 2 tests failed: a, b)'
  const events: WorkEvent[] = [
    ...first.events,
    { type: 'dispatched', seq: 1, at: '2026-11-09T01:00:00.000Z', stepId: 'task', attemptId: 'a:1', executor: 'worker', capability: 'code-write', selected: 'fake/claude', candidates: [], inputs: {} },
    { type: 'observed', seq: 2, at: '2026-11-09T01:01:00.000Z', stepId: 'task', attemptId: 'a:1', status: 'succeeded', outputs: { change: CHANGE }, usage: { state: 'unknown' } },
    { type: 'verified', seq: 3, at: '2026-11-09T01:02:00.000Z', stepId: 'checks', attemptId: 'a:2', subject: CHANGE, criteria: 'c', verdict: 'fail', reason: 'unit: 2 tests failed: a, b', evidence: [evidence] },
    { type: 'terminal', seq: 4, at: '2026-11-09T01:05:00.000Z', outcome: 'failed', reason, results: {} },
  ]
  await table.put(first.id, { ...first, events, state: fold(['task', 'checks'], events) })
  const second = await admit(task(dir, 'df-3', 'again'))
  const note = specs.tasks.get(second.state.input!)!.note!
  assert.ok(note.includes(`${first.id} failed: ${reason}`), note)
  assert.ok(note.includes(`Task (read its instructions by this ID): ${first.state.input}`), note)
  assert.ok(note.includes(`change: Artifact ${CHANGE}, commit ${COMMIT}`), note)
  assert.ok(note.includes('verify step checks fail'), note)
  assert.ok(note.includes('unit: 2 tests failed: a, b'), note)
  assert.ok(note.includes(`evidence: ${evidence}`), note)
  assert.match(note, /start from its commit/)
})

test('a Task from before Items, and one naming an Item without a readable STATUS.md, are admitted as they are', async () => {
  const dir = repository(STATUS)
  const { specs, task, admit } = setup()
  const plain = task(dir)
  assert.equal((await admit(plain)).state.input, plain)
  assert.equal(specs.tasks.get(plain)!.task.item, undefined)
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'system-status-nogit-')))
  const lone = task(elsewhere, 'df-3')
  const admitted = await admit(lone)
  assert.match(specs.tasks.get(admitted.state.input!)!.note!, /not in STATUS\.md/)
})

const merged = (work: WorkRecord, merge: boolean, state: 'applied' | 'failed' = 'applied'): WorkRecord => {
  const events: WorkEvent[] = [
    ...work.events,
    { type: 'effect-intended', seq: 1, at: '2026-11-09T01:00:00.000Z', stepId: 'publish', operationId: 'op:1', capability: 'git.publish', subject: CHANGE, params: { merge }, provider: { ref: 'github', version: '1' } },
    { type: 'effect-observed', seq: 2, at: '2026-11-09T01:01:00.000Z', stepId: 'publish', operationId: 'op:1', state, reason: 'r', detail: merge ? { merged: 'true', mergeCommit: COMMIT } : { merged: 'false' } },
    { type: 'terminal', seq: 3, at: '2026-11-09T01:02:00.000Z', outcome: 'succeeded', reason: 'ok', results: { change: CHANGE } },
  ]
  return { ...work, events, state: fold(['task', 'publish'], events) }
}

test('an Item is done when a Work naming it was merged into dev, though STATUS.md still says [ ]; an unmerged or failed publish does not', async () => {
  const dir = repository(STATUS)
  const { controller, table, task, admit } = setup()
  const status = await readStatus(dir)
  const line = () => itemLines(status, dir, controller.list(), () => [], { item: 'df-3' })[0]
  const work = await admit(task(dir, 'df-3'))
  await table.put(work.id, merged(work, false))
  assert.match(line()!, /^\[ \] df-3 .* - todo: nobody$/)
  await table.put(work.id, merged(work, true, 'failed'))
  assert.match(line()!, /^\[ \] df-3 /)
  await table.put(work.id, merged(work, true))
  assert.equal(line(), `[x] df-3 The status of a project - done; last ${work.id}, ${CHANGE}`)
  assert.deepEqual(itemLines(status, dir, controller.list(), () => [], { state: 'done' }).map((l) => l.slice(0, 8)), ['[x] df-1', '[x] df-3'])
  // Merged for another Item or repository: not done.
  assert.match(itemLines(status, dir, controller.list(), () => [], { item: 'df-4' })[0]!, /todo: nobody/)
})

test('the takeover context opens with the Item\'s line and marks an earlier Work that changed nothing', async () => {
  const dir = repository(STATUS)
  const { table, specs, task, admit } = setup()
  const first = await admit(task(dir, 'df-3', 'make it'))
  const events: WorkEvent[] = [
    ...first.events,
    { type: 'dispatched', seq: 1, at: '2026-11-09T01:00:00.000Z', stepId: 'task', attemptId: 'a:1', executor: 'worker', capability: 'code-write', selected: 'fake/claude', candidates: [], inputs: {} },
    { type: 'observed', seq: 2, at: '2026-11-09T01:01:00.000Z', stepId: 'task', attemptId: 'a:1', status: 'failed', outputs: {}, reason: 'no change: the working tree is the same as the base commit abcdef0', usage: { state: 'unknown' } },
    { type: 'terminal', seq: 3, at: '2026-11-09T01:05:00.000Z', outcome: 'failed', reason: 'step task failed', results: {} },
  ]
  await table.put(first.id, { ...first, events, state: fold(['task'], events) })
  const second = await admit(task(dir, 'df-3', 'again'))
  const note = specs.tasks.get(second.state.input!)!.note!
  assert.match(note, /^\[ \] df-3 The status of a project - todo: nobody\n/, 'opens with the Item\'s line')
  assert.match(note, new RegExp(`- ${first.id} failed[^\\n]*\\n(  Task[^\\n]*\\n)?  changed nothing`))
})
