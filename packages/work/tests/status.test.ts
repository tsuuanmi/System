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
  const mergedRecord = { ...done, state: { ...done.state, effects: { publish: { stepId: 'publish', state: 'applied' as const, detail: { merged: 'true', mergeCommit: 'd'.repeat(40) } } } } }
  assert.equal(
    itemLines(merged, dir, controller.list(), () => [], { item: 'df-3' })[0],
    `[x] df-3 The status of a project - done; last ${work.id}, ${Object.values(done.state.results).join(', ')}`,
  )
  assert.equal(
    itemLines(merged, dir, [mergedRecord], () => [], { item: 'df-3' }, [], () => false)[0],
    `[x] df-3 The status of a project - done, not yet released; last ${work.id}, ${Object.values(done.state.results).join(', ')}`,
  )
  assert.equal(itemLines(merged, dir, [mergedRecord], () => [], { item: 'df-3' }, [], () => true)[0], `[x] df-3 The status of a project - done; last ${work.id}, ${Object.values(done.state.results).join(', ')}`)
  assert.equal(itemLines(merged, dir, [mergedRecord], () => [], { item: 'df-3' }, [], () => undefined)[0], `[x] df-3 The status of a project - done; last ${work.id}, ${Object.values(done.state.results).join(', ')}`)
})

test('a done Item reports the Outside failures recorded by its merged Work', () => {
  const dir = '/project'
  const at = '2026-11-11T00:00:00.000Z'
  const mergedRecord: WorkRecord = {
    id: 'work:merged',
    events: [
      { type: 'admitted', seq: 0, at, caller, specId: id('spec'), source: { kind: 'direct-task' }, item: { id: 'df-3', repository: dir } },
      { type: 'observed', seq: 1, at, stepId: 'task', attemptId: 'attempt:earlier', status: 'failed', outputs: {}, usage: { state: 'unknown' }, reason: 'Your workspace is out of credits' },
      { type: 'terminal', seq: 2, at, outcome: 'succeeded', reason: 'ok', results: {} },
    ],
    state: {
      status: 'succeeded', specId: id('spec'), criteria: {}, steps: {}, results: {},
      effects: { publish: { stepId: 'publish', state: 'applied', detail: { merged: 'true', mergeCommit: 'd'.repeat(40) } } },
    },
  }
  const lines = itemLines(parseStatus(TICKED), dir, [mergedRecord], () => [], { state: 'done' })
  assert.match(lines.find((line) => line.startsWith('[x] df-3 '))!, /; outside failures: 1/)
  assert.equal(lines[0], '[x] df-1 Drop Goals - done')
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

test('a done Item names only the Work\'s final Artifact, the merged change', () => {
  const dir = '/project'
  const admitted: WorkEvent[] = [{ type: 'admitted', seq: 0, at: '2026-11-09T00:00:00.000Z', caller, specId: id('spec'), source: { kind: 'workflow-file' }, item: { id: 'df-3', repository: dir } }]
  const work: WorkRecord = { id: 'work:merged', events: admitted, state: fold(['task', 'publish'], admitted) }
  const A = id('implementation change')
  const V1 = id('checks verdict')
  const events: WorkEvent[] = merged(work, true).events.map((event) => event.type === 'terminal'
    ? { ...event, results: { 'implement.change': A, 'docs.change': CHANGE, 'checks.checks': V1, 'plan.plan': A } }
    : event)
  const record: WorkRecord = { ...work, events, state: fold(['task', 'publish'], events) }

  assert.equal(
    itemLines(parseStatus(STATUS), dir, [record], () => [], { item: 'df-3' })[0],
    `[x] df-3 The status of a project - done; last ${work.id}, ${CHANGE}`,
  )
})

test('a done Item with a report names the report', () => {
  const dir = '/project'
  const workId = 'work:research'
  const R = id('research report')
  const S = id('research sources')
  const at = '2026-11-09T01:00:00.000Z'
  const events: WorkEvent[] = [
    { type: 'admitted', seq: 0, at, caller, specId: id('research spec'), source: { kind: 'workflow-file' }, item: { id: 'df-3', repository: dir } },
    { type: 'dispatched', seq: 1, at, stepId: 'investigate', attemptId: 'a:1', executor: 'worker', capability: 'research', selected: 'fake/research', candidates: [], inputs: {} },
    { type: 'observed', seq: 2, at, stepId: 'investigate', attemptId: 'a:1', status: 'succeeded', outputs: { report: R, sources: S }, usage: { state: 'unknown' } },
    { type: 'dispatched', seq: 3, at, stepId: 'citations', attemptId: 'a:2', executor: 'verifier', capability: 'citations', selected: 'fake/citations', candidates: [], inputs: { subject: S } },
    { type: 'verified', seq: 4, at, stepId: 'citations', attemptId: 'a:2', subject: S, criteria: 'citations', verdict: 'pass', reason: 'sources checked' },
    { type: 'terminal', seq: 5, at, outcome: 'succeeded', reason: 'accepted', results: { 'investigate.report': R, 'investigate.sources': S } },
  ]
  const record: WorkRecord = { id: workId, events, state: fold(['investigate', 'citations', 'accept'], events) }
  const line = itemLines(parseStatus(TICKED), dir, [record], () => [], { item: 'df-3' })[0]!

  assert.equal(line, `[x] df-3 The status of a project - done; last ${workId}, ${R}`)
  assert.ok(!line.includes(S), 'the done line omits the sources Artifact')
})

test('a done Item falls back to the last result when the merge has no intended event', () => {
  const dir = '/project'
  const admitted: WorkEvent[] = [{ type: 'admitted', seq: 0, at: '2026-11-09T00:00:00.000Z', caller, specId: id('spec'), source: { kind: 'workflow-file' }, item: { id: 'df-3', repository: dir } }]
  const work: WorkRecord = { id: 'work:merged', events: admitted, state: fold(['task', 'publish'], admitted) }
  const A = id('earlier result')
  const B = id('last result')
  const published = merged(work, true)
  // Older records can retain the applied effect without its intended event.
  const events: WorkEvent[] = published.events.filter((event) => event.type !== 'effect-intended')
    .map((event) => event.type === 'terminal' ? { ...event, results: { 'x.change': A, 'y.change': B } } : event)
  const record: WorkRecord = { ...published, events, state: { ...published.state, results: { 'x.change': A, 'y.change': B } } }

  assert.equal(
    itemLines(parseStatus(STATUS), dir, [record], () => [], { item: 'df-3' })[0],
    `[x] df-3 The status of a project - done; last ${work.id}, ${B}`,
  )
})

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

test('a session can claim an Item before it submits a Work: status shows who and since when, and a Work for the Item takes the claim over', async () => {
  const dir = repository(STATUS)
  const { controller, task, admit } = setup()
  const status = await readStatus(dir)
  const line = () => itemLines(status, dir, controller.list(), () => [], { item: 'df-3' }, controller.claims())[0]
  const claimed = await controller.claim(dir, 'df-3', { type: 'agent', operatorId: 'session-a' })
  assert.equal(claimed.who, 'session-a')
  assert.equal(line(), `[ ] df-3 The status of a project - doing: claimed by session-a since ${claimed.at}`)
  assert.deepEqual(itemLines(status, dir, controller.list(), () => [], { state: 'doing' }, controller.claims()).length, 1)
  assert.match(itemLines(status, dir, controller.list(), () => [], { item: 'df-4' }, controller.claims())[0]!, /todo: nobody/)

  // The same session claims again; another one is refused, naming the first, unless it forces.
  await controller.claim(dir, 'df-3', { type: 'agent', operatorId: 'session-a' })
  await assert.rejects(controller.claim(dir, 'df-3', { type: 'agent', operatorId: 'session-b' }), (error: Error) => error.message.includes('session-a') && error.message.includes('force'))
  assert.equal((await controller.claim(dir, 'df-3', { type: 'agent', operatorId: 'session-b' }, true)).who, 'session-b')

  // A Work submitted for the Item takes the claim over: the line shows the Work, not the claim.
  const work = await admit(task(dir, 'df-3'))
  assert.deepEqual(controller.claims(), [])
  assert.equal(line(), `[ ] df-3 The status of a project - doing: ${work.id} admitted, not running since ${work.events[0]!.at}`)
  // An Item with a running Work cannot be claimed.
  await assert.rejects(controller.claim(dir, 'df-3', { type: 'agent', operatorId: 'session-a' }), (error: Error) => error.message.includes(work.id))
})

test('an Item whose Work ended Satisfied is done, says "satisfied" and names the evidence; STATUS.md may still say [ ]', () => {
  const dir = '/project'
  const at = '2026-11-14T01:00:00.000Z'
  const V = id('satisfied verdict')
  const T = id('the tests')
  const events: WorkEvent[] = [
    { type: 'admitted', seq: 0, at, caller, specId: id('develop spec'), source: { kind: 'workflow-file' }, item: { id: 'df-3', repository: dir } },
    { type: 'dispatched', seq: 1, at, stepId: 'implement', attemptId: 'a:1', executor: 'worker', capability: 'code-write', selected: 'fake/claude', candidates: [], inputs: {} },
    { type: 'observed', seq: 2, at, stepId: 'implement', attemptId: 'a:1', status: 'succeeded', outputs: { change: CHANGE, satisfied: T }, usage: { state: 'unknown' } },
    { type: 'skipped', seq: 3, at, stepId: 'publish', reason: 'implement wrote satisfied' },
    { type: 'verified', seq: 4, at, stepId: 'satisfied-check', attemptId: 'a:2', subject: id('task'), criteria: 'satisfied-tests-v1', verdict: 'pass', reason: 'the tests passed', verdictId: V, evidence: [id('run')] },
    { type: 'terminal', seq: 5, at, outcome: 'succeeded', reason: 'satisfied', result: 'satisfied', results: { 'implement.change': CHANGE, 'implement.satisfied': T, 'satisfied-check.verdict': V } },
  ]
  const record: WorkRecord = { id: 'work:satisfied', events, state: fold(['implement', 'satisfied-check', 'publish'], events) }
  assert.equal(record.state.result, 'satisfied')
  assert.equal(record.state.steps.publish!.state, 'skipped')
  const line = (status: string) => itemLines(parseStatus(status), dir, [record], () => [], { item: 'df-3' })[0]
  assert.equal(line(STATUS), `[x] df-3 The status of a project - done, satisfied; last work:satisfied, ${V}`)
  assert.deepEqual(itemLines(parseStatus(STATUS), dir, [record], () => [], { state: 'done', item: 'df-3' }).length, 1)
  // A Work that succeeded without the result is not done by itself.
  const plain: WorkRecord = { ...record, state: { ...record.state, result: undefined } }
  assert.match(itemLines(parseStatus(STATUS), dir, [plain], () => [], { item: 'df-3' })[0]!, /^\[ \] df-3 .* - todo: nobody$/)
})

const AFTER = (...lines: string[]) => ['Aim: x', ...lines, ''].join('\n')

test('(after: id, id) at the end of an Item line is parsed and stripped from the title; prose without the colon stays title', () => {
  const parsed = parseStatus(AFTER(
    '- [ ] cm-1 First', '- [ ] cm-2 Second (after: cm-1)', '- [ ] cm-3 Third, with (after: cm-1) inside and more (after:cm-1,cm-2)',
    '- [ ] cm-4 Prose (after cm-1)', '- [x] cm-5 Early (after: cm-1) text after',
  ))
  assert.deepEqual(parsed.items, [
    { id: 'cm-1', title: 'First', done: false },
    { id: 'cm-2', title: 'Second', done: false, after: ['cm-1'] },
    { id: 'cm-3', title: 'Third, with (after: cm-1) inside and more', done: false, after: ['cm-1', 'cm-2'] },
    { id: 'cm-4', title: 'Prose (after cm-1)', done: false },
    { id: 'cm-5', title: 'Early (after: cm-1) text after', done: true },
  ])
  assert.deepEqual(parsed.problems, [])
})

test('an unknown id, a deleted id, a self-dependency and a cycle are problems naming them; strict mode throws on any problem', () => {
  const unknown = parseStatus(AFTER('- [ ] cm-1 One (after: cm-9, cm-2)', '- [ ] cm-2 Two'))
  assert.equal(unknown.problems.length, 1)
  assert.match(unknown.problems[0]!, /^line 2: .*cm-1.*unknown id cm-9/)
  const two = parseStatus(AFTER('- [ ] cm-2 Two (after: cm-3)', '- [ ] cm-3 Three (after: cm-2)'))
  assert.deepEqual(two.problems, ['cycle: cm-2 -> cm-3 -> cm-2'])
  const three = parseStatus(AFTER('- [ ] cm-1 A (after: cm-3)', '- [ ] cm-2 B (after: cm-1)', '- [ ] cm-3 C (after: cm-2)', '- [ ] cm-4 D (after: cm-3)'))
  assert.deepEqual(three.problems, ['cycle: cm-1 -> cm-3 -> cm-2 -> cm-1'])
  assert.deepEqual(parseStatus(AFTER('- [ ] cm-1 A (after: cm-1)')).problems, ['cycle: cm-1 -> cm-1'])
  assert.deepEqual(parseStatus(AFTER('- [ ] cm-1 A (after: )')).problems.length, 1)

  assert.deepEqual(parseStatus(AFTER('- [ ] cm-1 A', '- [ ] cm-2 B (after: cm-1)'), { strict: true }).items.length, 2)
  assert.throws(() => parseStatus(AFTER('- [ ] cm-1 A (after: cm-9)'), { strict: true }), /unknown id cm-9/)
  assert.throws(() => parseStatus(AFTER('- [ ] cm-2 B (after: cm-3)', '- [ ] cm-3 C (after: cm-2)'), { strict: true }), /cycle: cm-2 -> cm-3 -> cm-2/)
  assert.throws(() => parseStatus(AFTER('- [ ] cm-1 A', '- bad line'), { strict: true }), /line 3/)
  assert.throws(() => parseStatus('- [ ] cm-1 A', { strict: true }), /no Aim/)
})

test('a Blocked Item is shown as todo (blocked by ...), derived from what is done; a cycle shows blocked: cycle', () => {
  const lines = (text: string, records: WorkRecord[] = [], filter: { state?: 'todo' | 'doing' | 'done'; item?: string } = {}) => itemLines(parseStatus(text), '/p', records, () => [], filter)
  const text = AFTER(
    '- [x] cm-1 Done', '- [ ] cm-2 Open', '- [ ] cm-3 Ready (after: cm-1)', '- [ ] cm-4 Blocked (after: cm-1, cm-2)', '- [ ] cm-5 Two (after: cm-2, cm-4)',
    '- [ ] cm-6 Unknown (after: cm-99)', '- [ ] cm-7 Loop a (after: cm-8)', '- [ ] cm-8 Loop b (after: cm-7)', '- [ ] cm-9 Behind (after: cm-7)',
  )
  assert.deepEqual(lines(text), [
    '[x] cm-1 Done - done',
    '[ ] cm-2 Open - todo: nobody',
    '[ ] cm-3 Ready - todo: nobody',
    '[ ] cm-4 Blocked - todo (blocked by cm-2)',
    '[ ] cm-5 Two - todo (blocked by cm-2, cm-4)',
    '[ ] cm-6 Unknown - todo (blocked by cm-99)',
    '[ ] cm-7 Loop a - todo (blocked: cycle)',
    '[ ] cm-8 Loop b - todo (blocked: cycle)',
    '[ ] cm-9 Behind - todo (blocked by cm-7)',
  ])
  assert.equal(lines(text, [], { state: 'todo' }).length, 8, 'no fourth state: Blocked Items are todo')
  // Done as status defines it: a merged Work unblocks, being in the running release is not required.
  const merged: WorkRecord = {
    id: 'work:m', events: [{ type: 'admitted', seq: 0, at: '2026-11-11T00:00:00.000Z', caller, specId: id('s'), source: { kind: 'direct-task' }, item: { id: 'cm-2', repository: '/p' } }],
    state: { status: 'succeeded', specId: id('s'), criteria: {}, steps: {}, results: {}, effects: { publish: { stepId: 'publish', state: 'applied', detail: { merged: 'true', mergeCommit: 'd'.repeat(40) } } } },
  }
  const after = lines(text, [merged])
  assert.match(after[1]!, /^\[x\] cm-2 Open - done/)
  assert.equal(after[3], '[ ] cm-4 Blocked - todo: nobody')
  assert.equal(after[4], '[ ] cm-5 Two - todo (blocked by cm-4)')
  // A deleted Item is never done: its dependants stay Blocked.
  assert.equal(lines(AFTER('- [ ] cm-4 Blocked (after: cm-2)'))[0], '[ ] cm-4 Blocked - todo (blocked by cm-2)')
  // Existing lines are unchanged: df-13's prose is title text.
  assert.equal(lines(AFTER('- [ ] df-13 Routing (after df-14)'))[0], '[ ] df-13 Routing (after df-14) - todo: nobody')
})

test('admitting a Work for a Blocked Item is refused naming what blocks it, unless force; a Ready Item is not affected', async () => {
  const dir = repository(AFTER('- [ ] cm-1 First', '- [ ] cm-2 Second (after: cm-1)', '- [ ] cm-3 Loop (after: cm-4)', '- [ ] cm-4 Loop (after: cm-3)', '- [ ] cm-5 Third (after: cm-6)'))
  const { task, admit } = setup()
  await assert.rejects(admit(task(dir, 'cm-2')), (error: Error) => /blocked by cm-1/.test(error.message) && error.message.includes('force') && !error.message.includes('\n'))
  await assert.rejects(admit(task(dir, 'cm-3')), /blocked: cycle/)
  await assert.rejects(admit(task(dir, 'cm-5')), /blocked by cm-6/)
  assert.equal((await admit(task(dir, 'cm-2'), true)).state.status, 'running')
  assert.equal((await admit(task(dir, 'cm-1'))).state.status, 'running')
})
