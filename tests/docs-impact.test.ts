/**
 * Item dc-1: `tools/docs.py impact <base> --waivers <file>` (what the `docs` check runs against SYSTEM_CHECK_BASE) fails a change
 * that edits a covered path without its doc (DOC-IMP-001), passes with a waiver line, and ignores a change touching no covered path.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** tools/, docs/ and the covered file as a one-commit repository, then `change` committed on top; returns the impact run. */
function impact(change: (root: string) => void, waivers?: string): { status: number | null; stderr: string } {
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
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'change')
    const argv = ['tools/docs.py', 'impact', base, ...(waivers !== undefined ? ['--waivers', 'waivers'] : [])]
    const run = spawnSync('python3', argv, { cwd: root, encoding: 'utf8' })
    return { status: run.status, stderr: run.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('a covered path changed without its doc fails, naming DOC-IMP-001', () => {
  const run = impact((root) => appendFileSync(join(root, COVERED), '# touched\n'))
  assert.equal(run.status, 1)
  assert.match(run.stderr, new RegExp(`DOC-IMP-001 ${DOC}`))
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
