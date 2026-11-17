/**
 * Item rb-5: the `secrets` check (tools/secrets-check.sh) runs gitleaks on what the change adds to its base, names the file and the
 * rule, never prints the value, and fails closed when the binary is missing.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { checksFileSchema } from '../src/checks.ts'

const script = new URL('../../../tools/secrets-check.sh', import.meta.url).pathname
// Built from two parts so that this file is not itself a finding of the check it tests.
const FAKE_KEY = 'AKIA' + 'Z3MSJV4WWPLQ7XRT'
const gitleaks = process.env.GITLEAKS_BIN || [join(userInfo().homedir, '.local/bin/gitleaks'), '/usr/local/bin/gitleaks', '/usr/bin/gitleaks'].find((p) => existsSync(p))

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
/** A repository with a base commit and one change on it. */
function repo(files: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-check-'))
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'change')
  return { dir, base }
}
const run = (cwd: string, env: Record<string, string>) =>
  spawnSync('/bin/sh', [script], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: mkdtempSync(join(tmpdir(), 'secrets-home-')), ...env } })

test('the repository declares a `secrets` check that runs on every change', () => {
  const { checks } = checksFileSchema.parse(parse(readFileSync(new URL('../../../.system/checks.yaml', import.meta.url), 'utf8')))
  const check = checks.find((c) => c.name === 'secrets')
  assert.ok(check)
  assert.match(check.run, /tools\/secrets-check\.sh/)
  assert.equal(check.paths, undefined)
  assert.ok(check.timeoutSeconds <= 120)
})

test('a missing binary fails closed with the install message', () => {
  const { dir, base } = repo({ 'a.txt': 'nothing\n' })
  try {
    for (const env of [{ GITLEAKS_BIN: '/nonexistent/gitleaks' }, { SYSTEM_GITLEAKS_NONE: '1' }] as Record<string, string>[]) {
      const r = run(dir, { SYSTEM_CHECK_BASE: base, ...env })
      assert.notEqual(r.status, 0)
      assert.match(r.stderr, /install gitleaks: .*runbook/)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a change adding an AWS-style key fails naming the file and rule, without the value', { skip: !gitleaks }, () => {
  const { dir, base } = repo({ 'config/aws.env': `aws_access_key_id = "${FAKE_KEY}"\n` })
  try {
    const r = run(dir, { SYSTEM_CHECK_BASE: base, GITLEAKS_BIN: gitleaks! })
    assert.notEqual(r.status, 0)
    const out = r.stdout + r.stderr
    assert.match(out, /config\/aws\.env/)
    assert.match(out, /aws-access-token/)
    assert.doesNotMatch(out, new RegExp(FAKE_KEY))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a change without secrets passes, and a secret already in the base is not the change', { skip: !gitleaks }, () => {
  const { dir, base } = repo({ 'a.txt': 'nothing here\n' })
  try {
    assert.equal(run(dir, { SYSTEM_CHECK_BASE: base, GITLEAKS_BIN: gitleaks! }).status, 0)
    const withKey = repo({ 'aws.env': `k = "${FAKE_KEY}"\n` })
    try {
      const head = git(withKey.dir, 'rev-parse', 'HEAD')
      assert.equal(run(withKey.dir, { SYSTEM_CHECK_BASE: head, GITLEAKS_BIN: gitleaks! }).status, 0)
    } finally { rmSync(withKey.dir, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
