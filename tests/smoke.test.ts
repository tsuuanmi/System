/**
 * Offline smoke test: boot the real `system` profile in a throwaway DSH home.
 * Needs `corepack pnpm install` and `corepack pnpm build`; no model credentials.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'system-smoke-'))
const patch = join(home, 'profiles', 'system', 'cordis.patch.yml')

/** The rows the profile must mount, in order: nothing from dsh-base. */
const EXPECTED_ROWS = ['storage', 'storage-sqlite', 'storage-domain', 'attachment-local', 'subprocess', 'credentials', 'system-app']

function system(...args: string[]) {
  const ran = spawnSync(process.execPath, [join(repo, 'bin', 'system'), ...args], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

function doctor() {
  const ran = system('doctor', '--json')
  return { status: ran.status, report: JSON.parse(ran.stdout) as { ok: boolean; rows: { id: string; mounted: boolean }[] } }
}

before(() => {
  const ran = system('init')
  assert.equal(ran.status, 0, ran.stderr)
})

after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('a command before init names the fix', () => {
  const empty = mkdtempSync(join(tmpdir(), 'system-empty-'))
  try {
    const ran = spawnSync(process.execPath, [join(repo, 'bin', 'system'), 'doctor'], { env: { ...process.env, DSH_HOME: empty }, encoding: 'utf8' })
    assert.equal(ran.status, 1)
    assert.match(ran.stderr, /run `system init` first/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('the profile boots and doctor reports every row and durable storage', () => {
  const { status, report } = doctor()
  assert.equal(status, 0)
  assert.equal(report.ok, true)
  assert.ok(report.rows.every((row) => row.mounted))
})

test('the effective composition is exactly the System bundle', () => {
  const ran = system('--dump-config')
  assert.equal(ran.status, 0, ran.stderr)
  const rows = [...ran.stdout.matchAll(/^- id: (\S+)/gm)].map((match) => match[1])
  assert.deepEqual(rows, EXPECTED_ROWS)
  assert.doesNotMatch(ran.stdout, /dsh-base|dsh-agent|dsh-llm/)
})

test('an optional row disabled by config is reported, its package stays installed', () => {
  writeFileSync(patch, '- id: credentials\n  disabled: true\n')
  try {
    const { status, report } = doctor()
    assert.equal(status, 0)
    assert.equal(report.rows.find((row) => row.id === 'credentials')?.mounted, false)
    const installed = readFileSync(join(repo, 'packages', 'bundle', 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'package.json'), 'utf8')
    assert.match(installed, /"version": "0.2.2-rc.1"/)
  } finally {
    writeFileSync(patch, '[]\n')
  }
})

test('a required row disabled by config fails closed', () => {
  writeFileSync(patch, '- id: storage-sqlite\n  disabled: true\n')
  try {
    const { status, report } = doctor()
    assert.equal(status, 1)
    assert.equal(report.ok, false)
    assert.equal(report.rows.find((row) => row.id === 'storage-sqlite')?.mounted, false)
  } finally {
    writeFileSync(patch, '[]\n')
  }
})

test('init is repeatable and keeps the operator patch', () => {
  writeFileSync(patch, '# kept\n[]\n')
  const ran = system('init')
  assert.equal(ran.status, 0, ran.stderr)
  assert.equal(readFileSync(patch, 'utf8'), '# kept\n[]\n')
})

test('the work namespace exists and says it is not implemented yet', () => {
  const ran = system('work')
  assert.equal(ran.status, 2)
  assert.match(ran.stdout, /milestone M2/)
})
