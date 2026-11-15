/**
 * `system bootstrap check` through the real `bin/system`, against a temporary git repository, with no Host and no
 * profile: it reads git only, so a throwaway DSH home with nothing in it is enough.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-bootstrap')
const dir = mkdtempSync(join(tmpdir(), 'bootstrap-smoke-'))
after(() => { rmSync(cli.home, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) })

const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })

test('bootstrap check prints one line per item, exits 0 when all pass and non-zero when one fails', () => {
  git('init', '-q', '-b', 'dev')
  mkdirSync(join(dir, '.system'))
  writeFileSync(join(dir, '.system', 'checks.yaml'), 'checks:\n  - name: unit\n    run: "true"\n')
  writeFileSync(join(dir, 'STATUS.md'), '# System status\nAim: A thing.\n- [ ] bs-1 First\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'x')
  const before = git('status', '--porcelain') + git('for-each-ref') + git('worktree', 'list')

  const missing = cli.run(['bootstrap', 'check', '--repo', dir])
  assert.equal(missing.status, 1, missing.stderr)
  assert.match(missing.stdout, /fail: .*origin/)
  assert.equal(missing.stdout.trimEnd().split('\n').length, 6)

  git('remote', 'add', 'origin', 'https://github.com/o/r.git')
  const ran = cli.run(['bootstrap', 'check', '--repo', dir])
  assert.equal(ran.status, 0, ran.stdout + ran.stderr)
  assert.equal(ran.stdout.trimEnd().split('\n').length, 6)
  assert.ok(ran.stdout.trimEnd().split('\n').every((line) => line.endsWith(': ok')), ran.stdout)
  assert.equal(git('status', '--porcelain') + git('for-each-ref') + git('worktree', 'list'), before)
})
