/**
 * M2 gate on the real profile, with the `fakes` row enabled by a profile patch:
 * a direct Task and both Workflow files run through one controller; an invalid
 * Workflow dispatches zero Workers; the pinned spec survives a file edit and a
 * killed host.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'system-work-'))
const patch = join(home, 'profiles', 'system', 'cordis.patch.yml')
const log = join(home, 'fake-calls.log')
const FAKES_ON = `- id: fakes
  disabled: false
  config:
    workers: [code-write, research, web-search]
    verifiers: [code.required-checks, research.citation-check]
`

function system(args: string[], env: Record<string, string> = {}) {
  const ran = spawnSync(process.execPath, [join(repo, 'bin', 'system'), ...args], {
    env: { ...process.env, DSH_HOME: home, SYSTEM_FAKE_LOG: log, SYSTEM_OPERATOR_ID: 'tester', ...env },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { status: ran.status, signal: ran.signal, stdout: ran.stdout, stderr: ran.stderr }
}

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as {
  events: { type: string; stepId?: string }[]
  state: { status: string; specId: string; steps: Record<string, { attempts: string[] }> }
}

let input = ''

before(() => {
  assert.equal(system(['init']).status, 0)
  writeFileSync(patch, FAKES_ON)
  const task = join(home, 'task.txt')
  writeFileSync(task, 'make the tests pass\n')
  input = system(['artifact', 'put', task, '--media-type', 'text/plain']).stdout.trim()
  assert.match(input, /^sha256:/)
})

after(() => {
  rmSync(home, { recursive: true, force: true })
})

test('a direct Task, Software Engineering and Research all succeed through one controller', () => {
  rmSync(log, { force: true })
  const task = system(['work', 'submit', '--capability', 'code-write', '--input', input])
  assert.equal(task.status, 0, task.stderr)
  const se = system(['work', 'submit', '--workflow', join(repo, 'workflows', 'software-engineering.yaml'), '--input', input])
  assert.equal(se.status, 0, se.stderr)
  const research = system(['work', 'submit', '--workflow', join(repo, 'workflows', 'research.yaml'), '--input', input])
  assert.equal(research.status, 0, research.stderr)
  assert.deepEqual(calls().map((line) => line.split(' ')[1]), ['task', 'implement', 'investigate'])
  for (const out of [task, se, research]) {
    const workId = out.stdout.trim().split('\n')[0]!
    assert.equal(show(workId).state.status, 'succeeded')
    assert.equal(system(['work', 'replay', workId]).status, 0, 'replay of the recorded events matches the stored state')
  }
})

test('an invalid Workflow is refused before any Worker runs, and no Work is created', () => {
  rmSync(log, { force: true })
  const broken = join(home, 'broken.yaml')
  writeFileSync(broken, readFileSync(join(repo, 'workflows', 'research.yaml'), 'utf8').replace('dependsOn: [investigate]', 'dependsOn: [citations]'))
  const before = system(['work', 'list']).stdout
  const ran = system(['work', 'submit', '--workflow', broken, '--input', input])
  assert.equal(ran.status, 1)
  assert.match(ran.stderr, /invalid workflow: .*(depends on itself|cycle)/)
  assert.deepEqual(calls(), [])
  assert.equal(system(['work', 'list']).stdout, before)
})

test('the pinned spec survives a Workflow file edit and a killed host; done steps never re-run', () => {
  rmSync(log, { force: true })
  const file = join(home, 'se.yaml')
  copyFileSync(join(repo, 'workflows', 'software-engineering.yaml'), file)
  const crashed = system(['work', 'submit', '--workflow', file, '--input', input], { SYSTEM_FAKE_CRASH_AT: 'implement' })
  assert.equal(crashed.signal, null, 'the wrapper survives; the DSH host child was killed')
  assert.notEqual(crashed.status, 0)
  const workId = crashed.stdout.trim()
  const pinned = show(workId).state.specId
  assert.equal(show(workId).state.status, 'running')

  // Edit the file mid-run: a capability no Worker has. Running Work must not notice.
  writeFileSync(file, readFileSync(file, 'utf8').replace('capabilities: [code-write]', 'capabilities: [teleport]'))
  const resumed = system(['work', 'run', workId])
  assert.equal(resumed.status, 0, resumed.stderr)
  const done = show(workId)
  assert.equal(done.state.specId, pinned)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(done.events.map((e) => e.type), ['admitted', 'dispatched', 'attempt-lost', 'dispatched', 'observed', 'dispatched', 'verified', 'terminal'])
  assert.equal(done.state.steps.implement!.attempts.length, 2)
  assert.deepEqual(calls().map((line) => line.split(' ')[1]), ['implement', 'implement'])

  // New admissions read the edited file and are refused for the missing capability.
  const fresh = system(['work', 'submit', '--workflow', file, '--input', input])
  assert.equal(fresh.status, 1)
  assert.match(fresh.stderr, /needs Worker capability teleport/)
})

test('with the fakes row disabled by config, admission names the missing capability', () => {
  writeFileSync(patch, '[]\n')
  try {
    const ran = system(['work', 'submit', '--workflow', join(repo, 'workflows', 'research.yaml'), '--input', input])
    assert.equal(ran.status, 1)
    assert.match(ran.stderr, /needs Worker capability research, which no enabled Worker provides/)
    assert.match(ran.stderr, /needs verifier research.citation-check, which no enabled verifier provides/)
  } finally {
    writeFileSync(patch, FAKES_ON)
  }
})

test('a held Work exits 3 and a failed verification exits 1', () => {
  const research = join(repo, 'workflows', 'research.yaml')
  assert.equal(system(['work', 'submit', '--workflow', research, '--input', input], { SYSTEM_FAKE_VERDICT: 'inconclusive' }).status, 3)
  assert.equal(system(['work', 'submit', '--workflow', research, '--input', input], { SYSTEM_FAKE_VERDICT: 'fail' }).status, 1)
})

test('SQLite commits are durable: WAL with synchronous FULL (DSH sets neither pragma but the journal)', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const probe = new DatabaseSync(join(home, 'probe.sqlite'))
  try {
    probe.exec('PRAGMA journal_mode = WAL')
    assert.deepEqual({ ...probe.prepare('PRAGMA synchronous').get() }, { synchronous: 2 })
    const options = probe.prepare('PRAGMA compile_options').all().map((row) => (row as { compile_options: string }).compile_options)
    assert.ok(options.includes('DEFAULT_WAL_SYNCHRONOUS=2'), options.join(','))
  } finally {
    probe.close()
  }
})

test('a three-step Work record stays small', () => {
  const ran = system(['work', 'submit', '--workflow', join(repo, 'workflows', 'software-engineering.yaml'), '--input', input])
  const bytes = Buffer.byteLength(system(['work', 'show', ran.stdout.trim()]).stdout)
  assert.ok(bytes < 16 * 1024, `record is ${bytes} bytes`)
})
