/**
 * Offline smoke test: boot the real `system` profile in a throwaway DSH home.
 * Needs `corepack pnpm install` and `corepack pnpm build`; no model credentials.
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-smoke', {})
const home = cli.home
const patch = join(home, 'profiles', 'system', 'cordis.patch.yml')

/** The rows the profile must mount, in order: nothing from dsh-base. */
const EXPECTED_ROWS = ['storage', 'storage-sqlite', 'storage-domain', 'attachment-local', 'artifacts', 'work', 'fakes', 'subprocess', 'verifiers', 'effects', 'agents', 'worker-acp', 'credentials', 'system-app']

const system = (...args: string[]) => cli.run(args)
const human = { SYSTEM_CALLER: 'human' }

function doctor() {
  const ran = system('doctor', '--json')
  return { status: ran.status, report: JSON.parse(ran.stdout) as { ok: boolean; rows: { id: string; mounted: boolean }[] } }
}

before(async () => {
  const ran = system('init')
  assert.equal(ran.status, 0, ran.stderr)
  await cli.start()
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

test('a command before init names the fix', () => {
  const empty = systemCli('system-empty', {})
  try {
    const ran = empty.run(['doctor'])
    assert.equal(ran.status, 1)
    assert.match(ran.stderr, /run `system init` first/)
  } finally {
    rmSync(empty.home, { recursive: true, force: true })
  }
})

test('the profile boots and doctor reports every row and durable storage', () => {
  const { status, report } = doctor()
  assert.equal(status, 0)
  assert.equal(report.ok, true)
  assert.ok(report.rows.every((row) => row.mounted || row.id === 'worker-acp'), 'only the optional ACP plugin starts disabled')
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

test('the fakes row is installed but off by default', () => {
  const ran = system('--dump-config')
  assert.match(ran.stdout, /- id: fakes\n  name: '@system\/fakes'\n  disabled: true/)
})

test('the optional ACP Worker plugin is installed but disabled without an ACP agent binary', () => {
  const config = system('--dump-config')
  assert.equal(config.status, 0, config.stderr)
  assert.match(config.stdout, /- id: worker-acp\n  name: '@system\/worker-acp'\n  disabled: true/)
  const { status, report } = doctor()
  assert.equal(status, 0)
  assert.equal(report.rows.find((row) => row.id === 'worker-acp')?.mounted, false)
})

test('ACP Worker row is independently enableable with no accounts while agents is disabled', () => {
  writeFileSync(patch, '- id: agents\n  disabled: true\n- id: worker-acp\n  disabled: false\n')
  try {
    const { status, report } = doctor()
    assert.equal(status, 0)
    assert.equal(report.rows.find((row) => row.id === 'agents')?.mounted, false)
    assert.equal(report.rows.find((row) => row.id === 'worker-acp')?.mounted, true)
  } finally {
    writeFileSync(patch, '[]\n')
  }
})

test('an Artifact stored in one Host is read by ID alone after a restart', async () => {
  const file = join(home, 'input.txt')
  writeFileSync(file, 'durable bytes\n')
  const put = system('artifact', 'put', file, '--media-type', 'text/plain')
  assert.equal(put.status, 0, put.stderr)
  const id = put.stdout.trim()
  assert.match(id, /^sha256:[0-9a-f]{64}$/)
  await cli.start()
  const shown = system('artifact', 'show', id)
  assert.equal(shown.status, 0, shown.stderr)
  const read = JSON.parse(shown.stdout) as { state: string; envelope: { id: string; kind: string; blob: { bytes: number; mediaType: string }; classification: string }; occurrences: unknown[] }
  assert.equal(read.state, 'stored')
  assert.equal(read.envelope.id, id)
  assert.deepEqual([read.envelope.kind, read.envelope.blob.bytes, read.envelope.blob.mediaType, read.envelope.classification], ['file', 14, 'text/plain', 'local-private'])
  const cat = system('artifact', 'cat', id)
  assert.equal(cat.status, 0, cat.stderr)
  assert.equal(cat.stdout, 'durable bytes\n')
  // Equal content stored again keeps its ID and adds an occurrence.
  assert.equal(system('artifact', 'put', file, '--media-type', 'text/plain').stdout.trim(), id)
  const again = JSON.parse(system('artifact', 'show', id).stdout) as { occurrences: unknown[] }
  assert.equal(again.occurrences.length, 2)
})

test('an unknown or malformed Artifact ID is reported, not invented', () => {
  const missing = system('artifact', 'show', `sha256:${'0'.repeat(64)}`)
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /"state": "missing"/)
  const malformed = system('artifact', 'show', 'not-an-id')
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /not an Artifact ID/)
})

test('an Artifact whose bytes were deleted reads as unavailable', () => {
  const file = join(home, 'doomed.txt')
  writeFileSync(file, 'soon gone\n')
  const id = system('artifact', 'put', file).stdout.trim()
  const { envelope } = JSON.parse(system('artifact', 'show', id).stdout) as { envelope: { blob: { attachmentId: string } } }
  const hex = envelope.blob.attachmentId.slice('sha256:'.length)
  const root = join(home, 'attachments', 'v1')
  rmSync(join(root, 'file-objects', hex.slice(0, 2), hex), { force: true })
  rmSync(join(root, 'files', hex.slice(0, 2), hex), { recursive: true, force: true })
  const cat = system('artifact', 'cat', id)
  assert.equal(cat.status, 1)
  assert.match(cat.stderr, /no longer stored/)
  assert.equal(system('artifact', 'show', id).status, 0, 'the record itself remains')
})

test('credentials set stores a piped value without printing it and keeps other entries', () => {
  const file = join(home, '.credentials.yaml')
  writeFileSync(file, 'version: 1\nrefs:\n  OTHER_KEY: keep-me\n', { mode: 0o600 })
  // The Host takes credentials only from a human, which a pipe is not unless it says so.
  const set = cli.run(['credentials', 'set', 'SMOKE_TOKEN'], { input: 'secret-value-123\n', env: human })
  assert.equal(set.status, 0, set.stderr)
  assert.doesNotMatch(set.stdout + set.stderr, /secret-value-123/)
  const status = cli.run(['credentials', 'status', 'SMOKE_TOKEN', 'OTHER_KEY', 'ABSENT_TOKEN'], { env: human })
  assert.equal(status.status, 1, 'one name is not configured')
  assert.match(status.stdout, /SMOKE_TOKEN {2}configured \(file\)/)
  assert.match(status.stdout, /OTHER_KEY {2}configured/)
  assert.match(status.stdout, /ABSENT_TOKEN {2}not configured/)
  assert.doesNotMatch(status.stdout, /secret-value-123|keep-me/)
  assert.match(readFileSync(file, 'utf8'), /OTHER_KEY: keep-me/)
})
