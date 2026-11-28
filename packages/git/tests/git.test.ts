import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { addWorktree, captureTree, git, removeWorktree } from '@system/git'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'system-git-'))
  const sh = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  sh('init', '-q')
  sh('config', 'user.email', 't@t')
  sh('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  sh('add', '.')
  sh('commit', '-qm', 'base')
  return { dir, base: sh('rev-parse', 'HEAD') }
}

test('git runs in a directory and names the failure', async () => {
  const { dir, base } = repo()
  try {
    assert.equal((await git(dir, ['rev-parse', 'HEAD'])).trim(), base)
    await assert.rejects(git(dir, ['rev-parse', '--verify', 'nope^{commit}']), /git rev-parse in .* failed/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a worktree is added, captured as an exact commit, and removed', async () => {
  const { dir, base } = repo()
  const wt = join(dir, '..', `wt-${Date.now()}`)
  try {
    await addWorktree(dir, wt, base)
    const same = await captureTree(dir, wt, base, 'none')
    assert.equal(same.commit, base)
    writeFileSync(join(wt, 'b.txt'), 'two\n')
    const changed = await captureTree(dir, wt, base, 'add b')
    assert.notEqual(changed.commit, base)
    assert.equal(changed.parent, base)
    assert.equal(await git(dir, ['show', `${changed.commit}:b.txt`]), 'two\n')
    assert.equal(readFileSync(join(wt, 'b.txt'), 'utf8'), 'two\n')
    await removeWorktree(dir, wt)
    assert.equal(existsSync(wt), false)
    assert.doesNotMatch(await git(dir, ['worktree', 'list']), /wt-/)
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(wt, { recursive: true, force: true }) }
})
