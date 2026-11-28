/**
 * Item dc-1: `tools/docs.py impact <base> --waivers <file>` (what the `docs` check runs against SYSTEM_CHECK_BASE) fails a change
 * that edits a covered path without its doc (DOC-IMP-001), passes with a waiver line, and ignores a change touching no covered path.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const COVERED = 'packages/bundle/cordis.patch.yml'
const DOC = 'docs/architecture/control-plane.md'

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.trim()
}

/** tools/, docs/ and the covered file as a one-commit repository, then `change` (committed by default); returns the impact run. */
function impact(change: (root: string) => void, waivers?: string, commit = true): { status: number | null; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'docs-impact-'))
  try {
    for (const path of ['tools', 'docs']) cpSync(path, join(root, path), { recursive: true, filter: (src) => !src.includes('__pycache__') })
    cpSync(COVERED, join(root, COVERED), { recursive: true })
    git(root, 'init', '-q')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'base')
    const base = git(root, 'rev-parse', 'HEAD')
    change(root)
    if (waivers !== undefined) writeFileSync(join(root, 'waivers'), waivers)
    if (commit) {
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'change')
    }
    const argv = ['tools/docs.py', 'impact', base, ...(waivers !== undefined ? ['--waivers', 'waivers'] : [])]
    const run = spawnSync('python3', argv, { cwd: root, encoding: 'utf8' })
    return { status: run.status, stderr: run.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a covered path changed without its doc fails, naming DOC-IMP-001 and the changed path', () => {
  const run = impact((root) => appendFileSync(join(root, COVERED), '# touched\n'))
  assert.equal(run.status, 1)
  assert.match(run.stderr, new RegExp(`DOC-IMP-001 ${DOC}:.*${COVERED}`))
})

test('an uncommitted change to a covered path fails, naming DOC-IMP-001 and the changed path', () => {
  const run = impact((root) => appendFileSync(join(root, COVERED), '# touched\n'), undefined, false)
  assert.equal(run.status, 1)
  assert.match(run.stderr, new RegExp(`DOC-IMP-001 ${DOC}:.*${COVERED}`))
})

test('a staged change to a covered path fails, naming the changed path', () => {
  const added = 'packages/host/src/staged-new.ts'
  const run = impact((root) => {
    mkdirSync(join(root, 'packages/host/src'), { recursive: true })
    writeFileSync(join(root, added), 'export const x = 1\n')
    git(root, 'add', added)
  }, undefined, false)
  assert.equal(run.status, 1)
  assert.match(run.stderr, new RegExp(`DOC-IMP-001 docs/architecture/host\\.md:.*${added}`))
})

test('an untracked non-ignored file matching covers fails, naming the path; gitignored files are ignored', () => {
  const untracked = 'packages/host/src/untracked.ts'
  const ignored = 'packages/host/src/ignored.log'
  const run = impact((root) => {
    writeFileSync(join(root, '.gitignore'), '*.log\n')
    mkdirSync(join(root, 'packages/host/src'), { recursive: true })
    writeFileSync(join(root, untracked), 'export const y = 2\n')
    writeFileSync(join(root, ignored), 'log\n')
  }, undefined, false)
  assert.equal(run.status, 1)
  assert.match(run.stderr, new RegExp(`DOC-IMP-001 docs/architecture/host\\.md:.*${untracked}`))
  assert.doesNotMatch(run.stderr, new RegExp(ignored))
})

test('an uncommitted doc update alongside an uncommitted covered path passes', () => {
  const run = impact((root) => {
    appendFileSync(join(root, COVERED), '# touched\n')
    appendFileSync(join(root, DOC), '\nUpdated.\n')
  }, undefined, false)
  assert.equal(run.status, 0, run.stderr)
})

test('committed and uncommitted changes to multiple covered paths name every changed path', () => {
  const a = 'packages/host/src/a.ts'
  const b = 'packages/host/src/b.ts'
  const run = impact((root) => {
    mkdirSync(join(root, 'packages/host/src'), { recursive: true })
    writeFileSync(join(root, a), 'export const a = 1\n')
    git(root, 'add', a)
    git(root, 'commit', '-qm', 'add a')
    writeFileSync(join(root, b), 'export const b = 2\n')
  }, undefined, false)
  assert.equal(run.status, 1)
  assert.match(run.stderr, new RegExp(`DOC-IMP-001 docs/architecture/host\\.md:.*${a}.*${b}`))
})

test('a waiver line in the waivers file passes it', () => {
  const run = impact((root) => appendFileSync(join(root, COVERED), '# touched\n'), `docs-unchanged: ${DOC} — still true\n`)
  assert.equal(run.status, 0, run.stderr)
})

test('a waiver for another doc does not pass it', () => {
  const run = impact((root) => appendFileSync(join(root, COVERED), '# touched\n'), 'docs-unchanged: docs/other.md — x\n')
  assert.equal(run.status, 1)
})

test('changing the doc with the covered path passes', () => {
  const run = impact((root) => { appendFileSync(join(root, COVERED), '# touched\n'); appendFileSync(join(root, DOC), '\nUpdated.\n') })
  assert.equal(run.status, 0, run.stderr)
})

test('a change touching no covered path is unaffected', () => {
  const run = impact((root) => writeFileSync(join(root, 'tools/unrelated.txt'), 'x\n'), '')
  assert.equal(run.status, 0, run.stderr)
})

test('the docs check runs the impact check against SYSTEM_CHECK_BASE with the committed waivers', () => {
  const checks = readFileSync('.system/checks.yaml', 'utf8')
  assert.match(checks, /docs\.py impact "\$SYSTEM_CHECK_BASE" --waivers \.system\/docs-waivers/)
})
