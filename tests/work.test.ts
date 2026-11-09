/**
 * M2 gate on the real profile, with the `fakes` row enabled by a profile patch:
 * a direct Task and both Workflow files run through one controller; an invalid
 * Workflow dispatches zero Workers; the pinned spec survives a file edit and a
 * killed host.
 */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-work', { SYSTEM_OPERATOR_ID: 'tester' })
const home = cli.home
const patch = join(home, 'profiles', 'system', 'cordis.patch.yml')
const log = join(home, 'fake-calls.log')
const FAKES_ON = `- id: verifiers
  disabled: true
- id: effects
  disabled: true
- id: fakes
  disabled: false
  config:
    workers: [code-write, research, web-search, tier.standard]
    verifiers: [code.required-checks, research.citation-check]
    effects: [git.publish]
`


const system = (args: string[]) => cli.run(args)
/** The Host of the home, with the fake Workers' hooks in its environment. */
const host = (env: Record<string, string> = {}) => cli.start({ env: { SYSTEM_FAKE_LOG: log, ...env } })

const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as {
  events: { type: string; stepId?: string }[]
  state: { status: string; specId: string; steps: Record<string, { attempts: string[] }> }
}

let input = ''

before(async () => {
  assert.equal(system(['init']).status, 0)
  writeFileSync(patch, FAKES_ON)
  await host()
  const task = join(home, 'task.txt')
  writeFileSync(task, 'make the tests pass\n')
  input = system(['artifact', 'put', task, '--media-type', 'text/plain']).stdout.trim()
  assert.match(input, /^sha256:/)
})

after(async () => {
  await cli.stop()
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

test('the pinned spec survives a Workflow file edit and a killed host; done steps never re-run', { timeout: 120_000 }, async () => {
  rmSync(log, { force: true })
  const file = join(home, 'se.yaml')
  copyFileSync(join(repo, 'workflows', 'software-engineering.yaml'), file)
  copyFileSync(join(repo, 'workflows', 'code-checks.yaml'), join(home, 'code-checks.yaml'))
  await host({ SYSTEM_FAKE_CRASH_AT: 'implement' })
  const crashed = system(['work', 'submit', '--workflow', file, '--input', input])
  assert.equal(crashed.signal, null, 'the CLI survives; the Host was killed')
  assert.notEqual(crashed.status, 0)
  const workId = crashed.stdout.trim()
  await host()
  const pinned = show(workId).state.specId
  assert.equal(show(workId).state.status, 'running')

  // Edit the file mid-run: a capability no Worker has. Running Work must not notice.
  writeFileSync(file, readFileSync(file, 'utf8').replace('capabilities: [code-write]', 'capabilities: [teleport]'))
  const resumed = system(['work', 'run', workId])
  assert.equal(resumed.status, 0, resumed.stderr)
  const done = show(workId)
  assert.equal(done.state.specId, pinned)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(done.events.map((e) => e.type), ['admitted', 'dispatched', 'attempt-lost', 'dispatched', 'observed', 'dispatched', 'verified', 'effect-intended', 'effect-observed', 'terminal'])
  assert.equal(done.state.steps.implement!.attempts.length, 2)
  assert.deepEqual(calls().map((line) => line.split(' ')[1]), ['implement', 'implement'])

  // New admissions read the edited file and are refused for the missing capability.
  const fresh = system(['work', 'submit', '--workflow', file, '--input', input])
  assert.equal(fresh.status, 1)
  assert.match(fresh.stderr, /needs Worker capability teleport/)
})

test('with the fakes row disabled by config, admission names the missing capability', async () => {
  writeFileSync(patch, '[]\n')
  try {
    await host()
    const ran = system(['work', 'submit', '--workflow', join(repo, 'workflows', 'research.yaml'), '--input', input])
    assert.equal(ran.status, 1)
    assert.match(ran.stderr, /needs Worker capability research, which no enabled Worker provides/)
    // The real `verifiers` row is on when the fakes are off, so the verifier is available.
    assert.doesNotMatch(ran.stderr, /needs verifier/)
  } finally {
    writeFileSync(patch, FAKES_ON)
    await host()
  }
})

test('a held Work exits 3 and a failed verification exits 1', async () => {
  const research = join(repo, 'workflows', 'research.yaml')
  await host({ SYSTEM_FAKE_VERDICT: 'inconclusive' })
  assert.equal(system(['work', 'submit', '--workflow', research, '--input', input]).status, 3)
  await host({ SYSTEM_FAKE_VERDICT: 'fail' })
  assert.equal(system(['work', 'submit', '--workflow', research, '--input', input]).status, 1)
  await host()
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
