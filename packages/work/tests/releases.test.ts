/** ms-2: a release is a merge of `dev` into `main`, read from the repository. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { releasesBy, releasesOf, releaseViolationPaths } from '../src/releases.ts'

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
function repo(): { dir: string; g: (...a: string[]) => string; commit: (name: string, at: string) => void; merge: (branch: string, at: string) => void; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'releases-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' }
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...a], { env, encoding: 'utf8' })
  const dated = (at: string, a: string[]) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...a], { env: { ...env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at }, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  return {
    dir, g,
    commit: (name, at) => { writeFileSync(join(dir, name), name); g('add', name); dated(at, ['commit', '-q', '-m', name]) },
    merge: (branch, at) => { dated(at, ['merge', '--no-ff', '-q', '-m', `merge ${branch}`, branch]) },
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('releasesOf counts only merges of dev into main, not other branches, and keeps them after dev moves on', async () => {
  const r = repo()
  try {
    r.commit('base', '2026-11-01T00:00:00Z')
    r.g('branch', 'dev'); r.g('branch', 'feature')
    r.g('checkout', '-q', 'feature'); r.commit('f', '2026-11-02T00:00:00Z')
    r.g('checkout', '-q', 'dev'); r.commit('d', '2026-11-03T00:00:00Z')
    r.g('checkout', '-q', 'main')
    r.merge('feature', '2026-11-04T00:00:00Z')
    r.merge('dev', '2026-11-05T00:00:00Z')
    assert.deepEqual(await releasesOf(r.dir), ['2026-11-05T00:00:00.000Z'])
    r.g('checkout', '-q', 'dev'); r.commit('d2', '2026-11-06T00:00:00Z'); r.commit('d3', '2026-11-07T00:00:00Z')
    assert.deepEqual(await releasesOf(r.dir), ['2026-11-05T00:00:00.000Z'])
  } finally { r.done() }
})

test('releasesOf has no releases without a dev branch, or outside a repository', async () => {
  const r = repo()
  const plain = mkdtempSync(join(tmpdir(), 'releases-plain-'))
  try {
    r.commit('base', '2026-11-01T00:00:00Z')
    r.g('branch', 'feature'); r.g('checkout', '-q', 'feature'); r.commit('f', '2026-11-02T00:00:00Z')
    r.g('checkout', '-q', 'main'); r.merge('feature', '2026-11-03T00:00:00Z')
    assert.deepEqual(await releasesOf(r.dir), [])
    assert.deepEqual(await releasesOf(plain), [])
  } finally { r.done(); rmSync(plain, { recursive: true, force: true }) }
})

/** relgate-1: a caller's release that changes what is not delegated (PLAN "Release delegated") is a violation. */
test('relgate-1: releaseViolations lists the not-delegated paths a caller\'s release changed, over the first parent to the merge', async () => {
  const r = repo()
  const write = (path: string) => { mkdirSync(dirname(join(r.dir, path)), { recursive: true }); writeFileSync(join(r.dir, path), `${path} ${r.g('rev-list', '--all', '--count')}`); r.g('add', path); r.g('commit', '-q', '-m', path) }
  const release = (at: string, files: string[], marker: boolean) => {
    r.g('checkout', '-q', ...(r.g('branch', '--list', 'dev') ? ['dev'] : ['-b', 'dev'])); for (const f of files) write(f)
    r.g('checkout', '-q', 'main')
    execFileSync('git', ['-C', r.dir, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-q', '-m', `Release ${at}${marker ? '\n\nReleased-By: caller' : ''}`, 'dev'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at } })
    const merge = r.g('rev-parse', 'HEAD').trim()
    return merge
  }
  try {
    r.commit('base', '2026-11-01T00:00:00Z')
    const first = release('2026-11-27T01:00:00Z', ['workflows/develop.yaml', 'packages/app/src/cli.ts'], true)
    release('2026-11-27T02:00:00Z', ['packages/app/src/cli.ts'], true)
    release('2026-11-27T03:00:00Z', ['packages/verifiers/src/checks.ts', 'packages/effects/src/x.ts'], false)
    release('2026-11-27T04:00:00Z', ['workflows/README.md', 'workflows/experiments/x.yaml'], true)
    const by = await releasesBy(r.dir)
    assert.deepEqual(by.violations, [{ merge: first, paths: ['workflows/develop.yaml'], at: '2026-11-27T01:00:00.000Z' }])
  } finally { r.done() }
})

test('relgate-1: notDelegated matches packages/verifiers/src, packages/effects/src and workflows/*.yaml only, and only for a caller\'s release', () => {
  const files = ['workflows/develop.yaml', 'workflows/README.md', 'workflows/experiments/x.yaml', 'packages/verifiers/src/checks.ts', 'packages/effects/src/a/b.ts', 'packages/verifiers/tests/t.ts', 'packages/app/src/cli.ts']
  assert.deepEqual(releaseViolationPaths(files, true), ['workflows/develop.yaml', 'packages/verifiers/src/checks.ts', 'packages/effects/src/a/b.ts'])
  assert.deepEqual(releaseViolationPaths(files, false), [])
})
