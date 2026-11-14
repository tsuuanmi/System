import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { bootstrapCheck, formatBootstrap } from '../src/bootstrap.ts'

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

const CHECKS = 'checks:\n  - name: unit\n    run: "true"\n'
const STATUS = '# System status\nAim: A thing.\n- [ ] bs-1 First\n- [x] bs-0 Zero\n'

interface Fixture {
  origin?: string | null
  /** 'dev' (local branch), 'origin' (only origin/dev), or none. */
  dev?: 'dev' | 'origin' | 'none'
  files?: Record<string, string | null>
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** A repository that passes every item, with the parts `fixture` changes. */
function repository(fixture: Fixture = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-'))
  roots.push(dir)
  git(dir, 'init', '-q', '-b', fixture.dev === 'origin' ? 'main' : 'dev')
  const files: Record<string, string | null> = { '.system/checks.yaml': CHECKS, 'STATUS.md': STATUS, ...fixture.files }
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'x')
  if (fixture.origin !== null) git(dir, 'remote', 'add', 'origin', fixture.origin ?? 'https://github.com/o/r.git')
  if (fixture.dev === 'origin') {
    git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD')
    git(dir, 'checkout', '-q', '--detach')
    git(dir, 'branch', '-q', '-D', 'main')
  }
  if (fixture.dev === 'none') git(dir, 'branch', '-q', '-m', 'main')
  return dir
}

const failures = async (dir: string) => (await bootstrapCheck(dir)).filter((r) => r.problem !== undefined)

test('a passing repository passes every item, one line each', async () => {
  const dir = repository({ files: { 'tools/docs.py': 'import sys\nsys.exit(0)\n' } })
  const results = await bootstrapCheck(dir)
  assert.equal(results.length, 6)
  assert.deepEqual(results.filter((r) => r.problem), [])
  const text = formatBootstrap(results)
  assert.equal(text.trimEnd().split('\n').length, 6)
  assert.ok(text.trimEnd().split('\n').every((line) => /: ok$/.test(line)), text)
})

test('origin/dev alone is enough, and is read in preference to dev', async () => {
  assert.deepEqual(await failures(repository({ dev: 'origin' })), [])
})

test('item 1: no origin, or one outside github.com, fails', async () => {
  for (const origin of [null, 'https://gitlab.com/o/r.git', 'https://example.com/github.com/r.git']) {
    const failed = await failures(repository({ origin }))
    assert.equal(failed.length, 1, String(origin))
    assert.equal(failed[0]!.name, 'origin')
  }
  for (const origin of ['git@github.com:o/r.git', 'ssh://git@github.com/o/r.git', 'https://github.com/o/r']) assert.deepEqual(await failures(repository({ origin })), [], origin)
})

test('item 2: with neither dev nor origin/dev, the item fails and so do those that read dev', async () => {
  const failed = await failures(repository({ dev: 'none' }))
  assert.deepEqual(failed.map((r) => r.name), ['dev', 'checks', 'guard', 'status'])
})

test('item 3: no checks file, or one the schema refuses, fails', async () => {
  for (const text of [null, 'checks: []\n', 'checks:\n  - name: Bad Name\n    run: x\n', 'not: valid\n']) {
    const failed = await failures(repository({ files: { '.system/checks.yaml': text } }))
    assert.equal(failed[0]!.name, 'checks', String(text))
    assert.match(failed[0]!.problem!, /checks\.yaml/)
  }
})

test('item 3: the checks are read from dev, not the working tree', async () => {
  const dir = repository()
  writeFileSync(join(dir, '.system', 'checks.yaml'), 'garbage: [\n')
  assert.deepEqual(await failures(dir), [])
})

test('item 4: every check limited to documentation paths fails the false-green guard', async () => {
  const docsOnly = 'checks:\n  - name: docs\n    run: "true"\n    paths: [docs/**, "*.md"]\n  - name: more\n    run: "true"\n    paths: [docs/a/b.md]\n'
  const failed = await failures(repository({ files: { '.system/checks.yaml': docsOnly } }))
  assert.deepEqual(failed.map((r) => r.name), ['guard'])
  assert.equal(failed[0]!.problem, 'every check is limited to documentation paths: a code change would pass with no check run')
})

test('item 4: a check without paths, or with a path that reaches code, passes the guard', async () => {
  const withCode = 'checks:\n  - name: docs\n    run: "true"\n    paths: [docs/**]\n  - name: unit\n    run: "true"\n    paths: [packages/**]\n'
  assert.deepEqual(await failures(repository({ files: { '.system/checks.yaml': withCode } })), [])
  const noPaths = 'checks:\n  - name: docs\n    run: "true"\n    paths: [docs/**]\n  - name: unit\n    run: "true"\n'
  assert.deepEqual(await failures(repository({ files: { '.system/checks.yaml': noPaths } })), [])
})

test('item 5: a STATUS.md with a problem, or none, fails', async () => {
  for (const text of [null, '# S\nAim: x.\n- [ ] bs-1 A\n- [ ] bs-1 B\n', '# S\nAim: x.\n- [ ] bs-1 A (after: bs-9)\n', 'junk line\n']) {
    const failed = await failures(repository({ files: { 'STATUS.md': text } }))
    assert.deepEqual(failed.map((r) => r.name), ['status'], String(text))
  }
})

test('item 6: a failing tools/docs.py fails; a repository without it skips the item', async () => {
  const failed = await failures(repository({ files: { 'tools/docs.py': 'import sys\nprint("broken link")\nsys.exit(1)\n' } }))
  assert.deepEqual(failed.map((r) => r.name), ['docs'])
  assert.match(failed[0]!.problem!, /broken link/)
  const results = await bootstrapCheck(repository())
  assert.equal(results.length, 6)
  assert.equal(results.find((r) => r.name === 'docs')!.problem, undefined)
})

test('item 6 runs `docs.py check` on dev in a temporary worktree and leaves the repository as it was', async () => {
  const script = 'import os, sys\nopen(os.path.join(os.getcwd(), "ran-" + " ".join(sys.argv[1:])), "w").close()\nsys.exit(0 if os.path.exists("STATUS.md") else 1)\n'
  const dir = repository({ files: { 'tools/docs.py': script } })
  writeFileSync(join(dir, 'untracked.txt'), 'mine')
  const before = git(dir, 'status', '--porcelain') + git(dir, 'worktree', 'list') + git(dir, 'for-each-ref')
  assert.deepEqual(await failures(dir), [])
  assert.equal(git(dir, 'status', '--porcelain') + git(dir, 'worktree', 'list') + git(dir, 'for-each-ref'), before)
  assert.equal(execFileSync('ls', ['-A', dir], { encoding: 'utf8' }).includes('ran-'), false)
})
