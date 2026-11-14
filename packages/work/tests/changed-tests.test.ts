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

test('a change that edits an existing test and adds a new one lists only the edited one', () => {
  const r = repo({ 'tests/a.test.ts': 'one\n', 'src/a.ts': 'x\n' }, (write) => {
    write('tests/a.test.ts', 'two\n')
    write('tests/b.test.ts', 'new\n')
    write('src/a.ts', 'y\n')
  })
  try {
    return changedTests(r.dir, r.base, r.commit).then((list) => assert.deepEqual(list, [{ path: 'tests/a.test.ts', change: 'modified' }]))
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
