import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildProgram, type Run } from '../src/cli.ts'
import { fakeHost } from './fake-host.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

/** A repository with origin, `main`, and `dev` with two Work merges after it (one touching a non-delegated path). */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-prepare-'))
  git(root, 'init', '--bare', '-b', 'main', 'origin.git')
  const repo = join(root, 'repo')
  git(root, 'clone', '-q', 'origin.git', 'repo')
  const commit = (message: string, file: string) => {
    mkdirSync(join(repo, file, '..'), { recursive: true })
    writeFileSync(join(repo, file), message)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', message)
    return git(repo, 'rev-parse', 'HEAD')
  }
  commit('base', 'README.md')
  git(repo, 'push', '-q', 'origin', 'HEAD:main')
  git(repo, 'checkout', '-q', '-b', 'dev')
  const one = commit('one', 'docs/a.md')
  commit('waiver', '.system/docs-waivers')
  writeFileSync(join(repo, '.system/docs-waivers'), '# c\ndocs-unchanged: docs/z.md - still true\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '--amend', '--no-edit')
  const two = commit('two', 'packages/effects/src/x.ts')
  const three = commit('three', 'docs/c.md')
  git(repo, 'push', '-q', 'origin', 'dev')
  const current = join(root, 'install', 'current')
  mkdirSync(join(root, 'install', 'releases', 'aaaaaaa1111'), { recursive: true })
  symlinkSync(join(root, 'install', 'releases', 'aaaaaaa1111'), current)
  return { root, repo, one, two, three, current }
}

const withEffects = (id: string, item: string | undefined, mergeCommit: string, account: string) => ({
  id, events: [
    { type: 'admitted', seq: 0, at: '2026-11-28T00:00:00Z', ...(item ? { item: { id: item, repository: 'x' } } : {}) },
    { type: 'dispatched', seq: 1, at: '2026-11-28T00:00:01Z', stepId: 's', executor: 'worker', selected: account },
  ],
  state: { status: 'succeeded', effects: { op: { state: 'applied', detail: { merged: 'true', mergeCommit } } } },
}) as any

test('rel-1: release prepare pushes release/<7 hex> at the commit and reports the merged Works, Items, defects, waivers and non-delegated paths', async () => {
  const f = fixture()
  const records: Record<string, any> = {
    'work:aaaaaaaa1': withEffects('work:aaaaaaaa1', 'ab-1', f.one, 'claude-a'),
    'work:bbbbbbbb2': withEffects('work:bbbbbbbb2', 'ab-2', f.two, 'codex-b'),
    'work:cccccccc3': withEffects('work:cccccccc3', 'ab-3', f.three, 'claude-a'),
  }
  const host = fakeHost({
    'work.list': () => Object.values(records).map((r) => ({ id: r.id, status: 'succeeded', specId: 's', item: r.events[0].item.id })),
    'work.show': ({ workId }) => records[workId!],
    'work.report': ({ workId }) => ({ id: workId, usage: { costUsdEstimate: workId!.endsWith('1') ? 1.5 : 2.25 } }),
    'defect.list': () => ({ defects: [{ id: 'sha256:d1', item: 'ab-2', foundBy: 'work:x', reason: 'broke it', date: '2026-11-28' }, { id: 'sha256:d2', item: 'ab-1', foundBy: 'x', reason: 'withdrawn one', date: '2026-11-28' }], withdrawals: [{ withdraws: 'sha256:d2', reason: 'wrong', date: '2026-11-28' }] }),
  })
  let out = ''
  let run: Run | undefined
  const io = { out: (t: string) => { out += t }, err: () => {} } as any
  const program = buildProgram(host, io, (r) => { run = r })
  program.exitOverride()
  process.env.SYSTEM_CODE = f.current
  await program.parseAsync(['node', 'system', 'release', 'prepare', f.two, '--repo', f.repo])
  assert.equal(await run!(), 0)
  const branch = `release/${f.two.slice(0, 7)}`
  assert.equal(git(f.repo, 'rev-parse', branch), f.two, 'the branch points at the given commit')
  assert.equal(git(join(f.root, 'origin.git'), 'rev-parse', branch), f.two, 'and is pushed')
  assert.match(out, /work:aaaaaaaa1/)
  assert.match(out, /work:bbbbbbbb2/)
  assert.doesNotMatch(out, /work:cccccccc3/, 'a Work after the commit is not in the range')
  assert.match(out, /ab-1/); assert.match(out, /ab-2/)
  assert.match(out, /claude-a/); assert.match(out, /codex-b/)
  assert.match(out, /\$1\.50/)
  assert.match(out, /packages\/effects\/src\/x\.ts/)
  assert.doesNotMatch(out, /docs\/a\.md\s*$/m, 'only non-delegated paths are listed')
  assert.match(out, /docs-unchanged: docs\/z\.md - still true/)
  assert.match(out, /broke it/)
  assert.doesNotMatch(out, /withdrawn one/)
  assert.match(out, /system update --to aaaaaaa1111/)
  assert.match(out, /How to revert/)
  assert.equal(git(f.repo, 'rev-parse', 'refs/remotes/origin/main'), git(f.repo, 'rev-list', '--max-parents=0', 'HEAD'), 'main is untouched')
})

test('rel-1: release prepare refuses a commit that is not on dev', async () => {
  const f = fixture()
  git(f.repo, 'checkout', '-q', '-b', 'other', 'origin/main')
  writeFileSync(join(f.repo, 'o.txt'), 'o'); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-q', '-m', 'o')
  const stray = git(f.repo, 'rev-parse', 'HEAD')
  let run: Run | undefined
  const program = buildProgram(fakeHost({}), { out: () => {}, err: () => {} } as any, (r) => { run = r })
  program.exitOverride()
  process.env.SYSTEM_CODE = f.current
  await program.parseAsync(['node', 'system', 'release', 'prepare', stray, '--repo', f.repo])
  await assert.rejects(run!(), /not on dev/)
})
