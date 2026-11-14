/** bs-1: `tools/bootstrap_docs.py --plan` lists create / unchanged / conflict per file and writes nothing. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function run(out: string, ...extra: string[]) {
  const r = spawnSync('python3', ['tools/bootstrap_docs.py', '--out', out, '--name', 'Plan Example', ...extra], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

function plan(out: string): Map<string, string> {
  const lines = run(out, '--plan').trim().split('\n')
  const map = new Map<string, string>()
  for (const line of lines) {
    const m = /^(create|unchanged|conflict) (.+)$/.exec(line)
    assert.ok(m, `unexpected plan line: ${line}`)
    map.set(m[2]!, m[1]!)
  }
  return map
}

test('--plan on an empty repository lists every file as create and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-plan-'))
  try {
    const p = plan(dir)
    assert.ok(p.size >= 9)
    assert.ok(p.has('docs/governance/documentation.md'))
    assert.deepEqual([...new Set(p.values())], ['create'])
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--plan after a real run lists every file as unchanged; an edited file is a conflict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bs-plan-'))
  try {
    run(dir)
    assert.deepEqual([...new Set(plan(dir).values())], ['unchanged'])
    appendFileSync(join(dir, 'AGENTS.md'), 'edit\n')
    const p = plan(dir)
    assert.equal(p.get('AGENTS.md'), 'conflict')
    assert.equal([...p.values()].filter((v) => v === 'conflict').length, 1)
    assert.equal([...p.values()].filter((v) => v === 'unchanged').length, p.size - 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--plan still refuses System\'s own checkout', () => {
  const r = spawnSync('python3', ['tools/bootstrap_docs.py', '--out', '.', '--plan'], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
})
