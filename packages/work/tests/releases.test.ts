/** ms-2: a release is a merge of `dev` into `main`, read from the repository. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { releasesOf } from '../src/releases.ts'

test('releasesOf counts the merge commits on the first parent of main, not the commits merged in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-releases-'))
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-17T10:00:00Z', GIT_AUTHOR_DATE: '2026-11-17T10:00:00Z' } })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a'), '1')
    git('add', 'a'); git('commit', '-q', '-m', 'one')
    git('checkout', '-q', '-b', 'dev')
    for (const n of ['2', '3']) { writeFileSync(join(dir, 'a'), n); git('commit', '-q', '-am', n) }
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', '-m', 'release', 'dev')
    assert.deepEqual(await releasesOf(dir), ['2026-11-17T10:00:00.000Z'])
    assert.deepEqual(await releasesOf(join(dir, 'missing')), [], 'a path that is not a repository has no releases')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
