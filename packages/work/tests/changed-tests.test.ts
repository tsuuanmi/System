/** tr-1: the existing tests a change modified or deleted, computed from git, with the Worker's reasons. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { NO_REASON, changedTests, isTestPath, withReasons } from '../src/changed-tests.ts'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

/** A repository with `files` committed; `change` edits it and returns the new commit. */
function repo(files: Record<string, string>, change: (write: (path: string, text: string) => void, remove: (path: string) => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'system-changed-tests-'))
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' }).trim()
  const write = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text) }
  run('init', '--quiet', '-b', 'main')
  for (const [path, text] of Object.entries(files)) write(path, text)
  run('add', '.')
  run('commit', '--quiet', '-m', 'base')
  const base = run('rev-parse', 'HEAD')
  change(write, (path) => rmSync(join(dir, path)))
  run('add', '--all')
  run('commit', '--quiet', '-m', 'change')
  return { dir, base, commit: run('rev-parse', 'HEAD'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('which paths are tests', () => {
  for (const path of ['tests/a.ts', 'packages/work/tests/a.ts', 'packages/work/tests/deep/a.ts', 'test-support/memory.ts', 'src/a.test.ts', 'src/a_test.go', 'src/test_a.py']) assert.equal(isTestPath(path), true, path)
  for (const path of ['src/a.ts', 'packages/work/src/tests.ts', 'docs/tests/a.md', 'packages/tests/a.ts', 'src/contest.ts', 'attest/a.ts']) assert.equal(isTestPath(path), false, path)
})

test('a change that edits an existing test and adds a new one lists only the edited one', async () => {
  const r = repo({ 'tests/a.test.ts': 'one\n', 'src/a.ts': 'x\n' }, (write) => {
    write('tests/a.test.ts', 'two\n')
    write('tests/b.test.ts', 'new\n')
    write('src/a.ts', 'y\n')
  })
  try {
    assert.deepEqual(await changedTests(r.dir, r.base, r.commit), [{ path: 'tests/a.test.ts', change: 'modified' }])
  } finally { r.done() }
})

test('a deleted test is listed, and so is a test renamed away', async () => {
  const r = repo({ 'tests/a.test.ts': 'one\n', 'packages/x/tests/b.ts': 'two\n', 'src/a.ts': 'x\n' }, (write, remove) => {
    remove('tests/a.test.ts')
    remove('packages/x/tests/b.ts')
    write('packages/x/tests/c.ts', 'two\n')
    remove('src/a.ts')
  })
  try {
    assert.deepEqual(await changedTests(r.dir, r.base, r.commit), [{ path: 'packages/x/tests/b.ts', change: 'deleted' }, { path: 'tests/a.test.ts', change: 'deleted' }])
  } finally { r.done() }
})

test('a change that touches no test lists none', async () => {
  const r = repo({ 'tests/a.test.ts': 'one\n', 'src/a.ts': 'x\n' }, (write) => write('src/a.ts', 'y\n'))
  try {
    assert.deepEqual(await changedTests(r.dir, r.base, r.commit), [])
    assert.deepEqual(await changedTests(r.dir, r.base, r.base), [])
  } finally { r.done() }
})

test('the Worker\'s reason is shown; a test without one shows "no reason given"', () => {
  const files = [{ path: 'tests/a.test.ts', change: 'modified' as const }, { path: 'tests/b.test.ts', change: 'deleted' as const }, { path: 'tests/c.test.ts', change: 'modified' as const }]
  const message = [
    'Done. Changed tests:',
    '- `tests/a.test.ts`: the message now names the Item',
    'tests/b.test.ts - covered by the new smoke test',
    'tests/c.test.ts.snap: not the file',
  ].join('\n')
  assert.deepEqual(withReasons(files, message), [
    { path: 'tests/a.test.ts', change: 'modified', reason: 'the message now names the Item' },
    { path: 'tests/b.test.ts', change: 'deleted', reason: 'covered by the new smoke test' },
    { path: 'tests/c.test.ts', change: 'modified', reason: NO_REASON },
  ])
  assert.equal(NO_REASON, 'no reason given')
  assert.deepEqual(withReasons(files.slice(0, 1), undefined), [{ path: 'tests/a.test.ts', change: 'modified', reason: 'no reason given' }])
})

/** tr-1 escaped defect: the list is against the Task's base, whatever attempt produced the change. */
async function reopened(edit: (write: (path: string, text: string) => void) => void) {
  const { Artifacts } = await import('@system/artifacts')
  const { memoryBlobStore, memoryRecordTable } = await import('../../../test-support/memory.ts')
  const { GIT_TREE_KIND, TASK_KIND, gitTreeSchema, taskSchema } = await import('../src/kinds.ts')
  const { specStore } = await import('../src/index.ts')
  const r = repo({ 'tests/old.test.ts': 'one\n', 'src/a.ts': 'x\n' }, (write) => write('README', 'r\n'))
  const run = (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { env, encoding: 'utf8' }).trim()
  const write = (path: string, text: string) => { mkdirSync(dirname(join(r.dir, path)), { recursive: true }); writeFileSync(join(r.dir, path), text) }
  const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
  artifacts.registerKind({ ...GIT_TREE_KIND, content: gitTreeSchema })
  artifacts.registerKind({ ...TASK_KIND, content: taskSchema })
  const producer = { type: 'operator' as const, ref: 'tan' }
  const put = async (content: { repository: string; commit: string; tree: string; parent?: string }) =>
    (await artifacts.put({ ...GIT_TREE_KIND, content, subject: { type: 'git-commit', ref: content.commit }, classification: 'local-private', producer })).id
  const tree = (c: string) => run('rev-parse', `${c}^{tree}`)
  const commit = (message: string) => { run('add', '--all'); run('commit', '--quiet', '-m', message); return run('rev-parse', 'HEAD') }
  const repository = run('rev-parse', '--show-toplevel')
  const base = await put({ repository, commit: r.base, tree: tree(r.base) })
  const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'x', base }, inputs: [base], classification: 'local-private', producer })).id
  // attempt 1 starts at the base; attempt 2 starts from attempt 1's change.
  edit(write)
  return { r, specs: specStore(artifacts), task, put, tree, repository, commit, write }
}

test('a reopened implement: a test modified in attempt 1 is listed though attempt 2 changed only source', async () => {
  const x = await reopened(() => {})
  try {
    x.write('tests/old.test.ts', 'two\n')
    const first = x.commit('attempt 1')
    x.write('src/a.ts', 'y\n')
    const second = x.commit('attempt 2')
    const change = await x.put({ repository: x.repository, commit: second, tree: x.tree(second), parent: first })
    assert.deepEqual(await x.specs.changedTests!(change, x.task), [{ path: 'tests/old.test.ts', change: 'modified' }])
    assert.deepEqual(await x.specs.changedTests!(change), [], 'without a Task, the attempt\'s start, as before')
  } finally { x.r.done() }
})

test('a test created in attempt 1 and edited in attempt 2 is not listed: it did not exist at the Task\'s base', async () => {
  const x = await reopened(() => {})
  try {
    x.write('tests/new.test.ts', 'one\n')
    const first = x.commit('attempt 1')
    x.write('tests/new.test.ts', 'two\n')
    const second = x.commit('attempt 2')
    const change = await x.put({ repository: x.repository, commit: second, tree: x.tree(second), parent: first })
    assert.deepEqual(await x.specs.changedTests!(change, x.task), [])
    assert.deepEqual(await x.specs.changedTests!(change), [{ path: 'tests/new.test.ts', change: 'modified' }], 'the attempt-start list is the defect')
  } finally { x.r.done() }
})
