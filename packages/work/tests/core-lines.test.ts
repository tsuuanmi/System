/** ir-9: the active core's lines at a range's start and end, counted from git (a trend, never a gate). */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { activeCoreLines } from '../src/core-lines.ts'
import { rangeReport } from '../src/measures.ts'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'core-lines-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' }
  const g = (at: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...a], { env: { ...env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at }, encoding: 'utf8' })
  const put = (file: string, lines: number) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), 'x\n'.repeat(lines)) }
  return { dir, g, put, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('activeCoreLines counts the .ts lines of packages/work/src and packages/artifacts/src on dev at the range start and end', async () => {
  const r = repo()
  try {
    r.g('2026-11-01T00:00:00Z', 'init', '-q', '-b', 'dev')
    r.put('packages/work/src/a.ts', 10); r.put('packages/artifacts/src/b.ts', 5); r.put('packages/work/src/notes.md', 99); r.put('packages/host/src/c.ts', 50)
    r.g('2026-11-01T00:00:00Z', 'add', '-A'); r.g('2026-11-01T00:00:00Z', 'commit', '-q', '-m', 'one')
    r.put('packages/work/src/a.ts', 14)
    r.g('2026-11-05T00:00:00Z', 'commit', '-q', '-am', 'two')
    r.put('packages/work/src/a.ts', 20)
    r.g('2026-11-10T00:00:00Z', 'commit', '-q', '-am', 'three')
    assert.deepEqual(await activeCoreLines([r.dir], '2026-11-03T00:00:00Z', '2026-11-08T00:00:00Z'), { start: 15, end: 19 })
    assert.deepEqual(await activeCoreLines([r.dir], '2026-11-03T00:00:00Z'), { start: 15, end: 25 }, 'without `until` the end is now')
    assert.deepEqual(await activeCoreLines([r.dir], '2026-10-01T00:00:00Z'), { start: 'unknown', end: 25 }, 'no commit before the start')
    assert.equal(await activeCoreLines([join(r.dir, 'missing')], '2026-11-03T00:00:00Z'), 'unknown', 'not a repository')
    assert.equal(await activeCoreLines([], '2026-11-03T00:00:00Z'), 'unknown')
  } finally { r.done() }
})

test('rangeReport shows the active core lines it is given, and unknown when it has none', () => {
  assert.deepEqual(rangeReport([], { since: '2026-11-01', activeCoreLines: { start: 3, end: 4 } }).activeCoreLines, { start: 3, end: 4 })
  assert.equal(rangeReport([], { since: '2026-11-01' }).activeCoreLines, 'unknown')
})
