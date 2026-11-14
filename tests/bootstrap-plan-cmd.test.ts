/** `system bootstrap plan` through the real `bin/system` (no Host): prints the plan, writes nothing. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-bootstrap-plan')
const dir = mkdtempSync(join(tmpdir(), 'bootstrap-plan-smoke-'))
after(() => { rmSync(cli.home, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) })

test('bootstrap plan prints files, checks, draft and commands, and writes nothing', () => {
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: [push]\njobs:\n  t:\n    runs-on: x\n    steps:\n      - name: Unit\n        run: npm test\n')
  const before = readdirSync(dir, { recursive: true }).join()
  const ran = cli.run(['bootstrap', 'plan', '--repo', dir])
  assert.equal(ran.status, 0, ran.stdout + ran.stderr)
  for (const h of ['== files ==', '== checks ==', '== draft .system/checks.yaml ==', '== commands ==']) assert.ok(ran.stdout.includes(h), h)
  assert.match(ran.stdout, /run: npm test/)
  assert.equal(readdirSync(dir, { recursive: true }).join(), before)
})
