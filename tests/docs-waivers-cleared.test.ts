/** tools/check-docs-waivers.py: the release rule (runbook, Release): a pull request into main fails while .system/docs-waivers has a waiver line. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const COMMENT = '# Waivers for the docs check, one line each. Cleared at release (runbook, Release).\n'
const WAIVER = 'docs-unchanged: docs/architecture/control-plane.md — still true'

function run(content: string | undefined): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'waivers-'))
  try {
    const file = join(dir, 'docs-waivers')
    if (content !== undefined) writeFileSync(file, content)
    const r = spawnSync('python3', ['tools/check-docs-waivers.py', file], { encoding: 'utf8' })
    return { status: r.status, out: r.stdout + r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a file with only the comment line passes', () => {
  assert.equal(run(COMMENT).status, 0)
  assert.equal(run(COMMENT + '\n  \n').status, 0)
})

test('a file with a waiver line fails and names the line', () => {
  const r = run(COMMENT + WAIVER + '\n')
  assert.equal(r.status, 1)
  assert.ok(r.out.includes(WAIVER), r.out)
  assert.ok(r.out.includes('Release'), r.out)
})

test('a missing file passes', () => {
  assert.equal(run(undefined).status, 0)
})
