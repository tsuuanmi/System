/**
 * Item ir-2: the `core-budget` check (tools/core-budget.sh) fails when the active core grows against the Work's base, unless the
 * change adds a `core +<delta>: <reason>` line to PLAN.md §2. It compares with the base, never with an absolute number.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { checksFileSchema } from '../src/checks.ts'

const script = new URL('../../../tools/core-budget.sh', import.meta.url).pathname
const lines = (n: number) => 'x\n'.repeat(n)
const PLAN = (extra = '') => `# Plan\n\n## 1. One\n\ntext\n\n## 2. Growth and feedback budgets\n\nbudget\n${extra}\n## 3. Three\n\nafter\n`

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const write = (dir: string, files: Record<string, string>) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
}
/** A base with a 10-line core (a 6-line and a 4-line file, one outside the core) and a change on it. */
function repo(change: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'core-budget-'))
  git(dir, 'init', '-q')
  write(dir, { 'packages/work/src/a.ts': lines(6), 'packages/artifacts/src/b.ts': lines(4), 'packages/work/src/notes.md': lines(50), 'packages/host/src/c.ts': lines(99), 'PLAN.md': PLAN() })
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  write(dir, change)
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'change')
  return { dir, base }
}
const run = (dir: string, base?: string) =>
  spawnSync('/bin/sh', [script], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...(base ? { SYSTEM_CHECK_BASE: base } : {}) } })
const check = (change: Record<string, string>, base = true) => {
  const { dir, base: b } = repo(change)
  try { return run(dir, base ? b : undefined) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('a change that grows the core fails, naming both counts and the delta', () => {
  const r = check({ 'packages/work/src/a.ts': lines(9) })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /10/)
  assert.match(r.stderr, /13/)
  assert.match(r.stderr, /\+3/)
})

test('a new file in the core counts as growth; a file outside the core does not', () => {
  assert.notEqual(check({ 'packages/artifacts/src/new.ts': lines(1) }).status, 0)
  assert.equal(check({ 'packages/host/src/c.ts': lines(200) }).status, 0)
})

test('a change that shrinks the core passes', () => {
  const r = check({ 'packages/work/src/a.ts': lines(2) })
  assert.equal(r.status, 0, r.stderr)
})

test('a growth with a PLAN §2 line naming it and a reason passes', () => {
  const r = check({ 'packages/work/src/a.ts': lines(9), 'PLAN.md': PLAN('core +3: the new reader\n') })
  assert.equal(r.status, 0, r.stderr)
})

test('a PLAN line that names a smaller delta, has no reason, or sits outside §2 does not justify', () => {
  const grow = { 'packages/work/src/a.ts': lines(9) }
  assert.notEqual(check({ ...grow, 'PLAN.md': PLAN('core +2: too small a delta\n') }).status, 0)
  assert.notEqual(check({ ...grow, 'PLAN.md': PLAN('core +3\n') }).status, 0)
  assert.notEqual(check({ ...grow, 'PLAN.md': PLAN() + 'core +3: in section 3\n' }).status, 0)
})

test('a line already in the base does not justify a later growth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-budget-'))
  try {
    git(dir, 'init', '-q')
    write(dir, { 'packages/work/src/a.ts': lines(6), 'PLAN.md': PLAN('core +3: old\n') })
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
    const base = git(dir, 'rev-parse', 'HEAD')
    write(dir, { 'packages/work/src/a.ts': lines(9) })
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'change')
    assert.notEqual(run(dir, base).status, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/** A base, then `other` merged on the target (a line on PLAN §2 each), then a branch from the base with `change`, merged into the target with a merge commit. */
function merged(other: Record<string, string>, change: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'core-budget-'))
  git(dir, 'init', '-q', '-b', 'dev')
  write(dir, { 'packages/work/src/a.ts': lines(6), 'packages/artifacts/src/b.ts': lines(4), 'PLAN.md': PLAN() })
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-qb', 'work')
  write(dir, change)
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'change')
  git(dir, 'checkout', '-q', 'dev')
  write(dir, other)
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'other')
  git(dir, 'merge', '--no-ff', '-qm', 'merge', 'work')
  return { dir, base }
}
const mergeCheck = (other: Record<string, string>, change: Record<string, string>) => {
  const { dir, base } = merged(other, change)
  try { return run(dir, base) } finally { rmSync(dir, { recursive: true, force: true }) }
}
/** ct-1 merged meanwhile: +2 with its own marker, placed before the text so the merge with the change's marker does not conflict. */
const ct1 = { 'packages/artifacts/src/other.ts': lines(2), 'PLAN.md': PLAN().replace('budget\n', 'core +2: ct-1, its own\nbudget\n') }

test('on a merge, another change merged meanwhile is not charged: +71 with `core +71` passes against the target', () => {
  const grow = { 'packages/work/src/a.ts': lines(77) }
  // Without its own marker the +71 fails, and the message names +71, not +73.
  const bare = mergeCheck(ct1, grow)
  assert.notEqual(bare.status, 0)
  assert.match(bare.stderr, /\+71/)
  const ok = mergeCheck(ct1, { ...grow, 'PLAN.md': PLAN('core +71: the reader\n') })
  assert.equal(ok.status, 0, ok.stderr)
})

test('markers summing to at least the growth pass; a marker below it fails; an old marker on the base does not count', () => {
  const grow = { 'packages/work/src/a.ts': lines(9) }
  assert.equal(check({ ...grow, 'PLAN.md': PLAN('core +1: one\ncore +2: two\n') }).status, 0)
  assert.equal(check({ ...grow, 'PLAN.md': PLAN('core +5: more\n') }).status, 0)
  const r = check({ ...grow, 'PLAN.md': PLAN('core +2: short\n') })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /\+3/)
})

test('without SYSTEM_CHECK_BASE it passes and says so', () => {
  const r = check({ 'packages/work/src/a.ts': lines(99) }, false)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /SYSTEM_CHECK_BASE/)
})

test('the repository declares `core-budget`, limited to the core and PLAN.md', () => {
  const { checks } = checksFileSchema.parse(parse(readFileSync(new URL('../../../.system/checks.yaml', import.meta.url), 'utf8')))
  const c = checks.find((x) => x.name === 'core-budget')
  assert.ok(c)
  assert.match(c.run, /tools\/core-budget\.sh/)
  assert.deepEqual(c.paths, ['packages/work/src/**', 'packages/artifacts/src/**', 'PLAN.md'])
})
