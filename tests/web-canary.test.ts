/**
 * WW4: tools/web-canary. The canary Task is stored by a deterministic command
 * (the real Host, no Worker runs); the runs and the report are read through a
 * fake `system` (SYSTEM_BIN) that serves scripted records, so the arithmetic
 * and the gate are checked without an account. No test reaches the real site.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const canary = join(repo, 'tools', 'web-canary')
const cli = systemCli('system-canary')
const { home } = cli
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [canary, ...args], { env: { ...process.env, ...cli.env, ...env }, encoding: 'utf8', timeout: 60_000 })

before(async () => {
  assert.equal(cli.run(['init']).status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents
  config:
    accounts:
      - ref: claude-code/default
        runtime: claude-code
        capabilities: [research]
        command: ${fakeAgent}
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN
`)
  await cli.start()
  assert.equal(cli.run(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], { input: 'fake-token\n' }).status, 0)
  await cli.start()
})
after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

test('the canary Task has the same Artifact ID every time, and is what the Work is given', { timeout: 120_000 }, () => {
  const first = run(['--task'])
  assert.equal(first.status, 0, first.stderr)
  const id = first.stdout.trim()
  assert.match(id, /^sha256:[0-9a-f]{64}$/)
  assert.equal(run(['--task']).stdout.trim(), id)
  const shown = JSON.parse(cli.run(['artifact', 'show', id]).stdout) as { state: string }
  assert.equal(shown.state, 'stored')
  assert.match(cli.run(['artifact', 'show', id]).stdout, /capital of France.*English Wikipedia.*https:\/\/en\.wikipedia\.org\//)
})

test('work submit --worker is refused for a Worker that is not registered', { timeout: 120_000 }, () => {
  const task = run(['--task']).stdout.trim()
  const refused = cli.run(['work', 'submit', '--capability', 'research', '--input', task, '--worker', 'web/chatgpt/nobody', '--no-run'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /no enabled Worker web\/chatgpt\/nobody/)
  assert.equal(cli.run(['work', 'list']).stdout.trim(), '', 'nothing was admitted')
})

// A fake `system`: serves db.json, appends each call to calls.json, and admits a Work on `work submit`
// with the next scripted outcome of its --worker.
const fake = `#!/usr/bin/env node
const fs = require('node:fs')
const db = JSON.parse(fs.readFileSync(process.env.FAKE_DB, 'utf8'))
const args = process.argv.slice(2)
const log = fs.existsSync(process.env.FAKE_CALLS) ? JSON.parse(fs.readFileSync(process.env.FAKE_CALLS, 'utf8')) : []
log.push(args)
fs.writeFileSync(process.env.FAKE_CALLS, JSON.stringify(log))
const [a, b] = args
if (a === 'workers') process.stdout.write(db.workers)
else if (a === 'task') process.stdout.write((args.at(-1).includes('Cite one page') ? db.oldTask : db.task) + '\\n')
else if (a === 'work' && b === 'list') for (const [id, r] of Object.entries(db.works)) process.stdout.write(id + '  ' + r.state.status.padEnd(9) + '  sha256:spec\\n')
else if (a === 'artifact' && b === 'cat') process.stdout.write(db.artifacts[args[2]])
else if (a === 'work' && b === 'show') process.stdout.write(JSON.stringify(db.works[args[2]]))
else if (a === 'work' && b === 'submit') {
  const worker = args[args.indexOf('--worker') + 1]
  const next = db.script[worker].shift()
  db.works[next.id] = next.record
  fs.writeFileSync(process.env.FAKE_DB, JSON.stringify(db))
  process.stdout.write(next.id + '\\n')
  process.exit(next.record.state.status === 'succeeded' ? 0 : 1)
} else process.exit(2)
`

const TASK = `sha256:${createHash('sha256').update('canary').digest('hex')}`
const OLD_TASK = `sha256:${createHash('sha256').update('old canary').digest('hex')}`
const WEB = ['registered: web/chatgpt/a, web/chatgpt/b, claude-code/default',
  'web/chatgpt/a   available   (web)',
  'web/chatgpt/b   available   (web)',
  'web/chatgpt/c   unavailable - no sign-in (web)',
  'claude-code/default available 2.1.0 (claude-code)', ''].join('\n')

/**
 * A Work record as `work show` prints it, reduced to what the canary reads. `stage` is where it stopped:
 * investigate (the Worker step failed with `reason`), citations (the verifier's verdict, with `reason`, was not a pass)
 * or accept (a later step; `reason` is the Work's).
 */
function record(account: string, at: string, seconds: number, outcome: 'succeeded' | 'failed' | 'held' | 'running', stage?: string, reason?: string, input = TASK) {
  const end = new Date(Date.parse(at) + seconds * 1000).toISOString()
  const done = { state: 'succeeded', outputs: {} }
  const steps: Record<string, { state: string; outputs: Record<string, string>; verdict?: string }> = {
    investigate: { state: 'succeeded', outputs: { report: 'sha256:r', sources: 'sha256:s' } }, citations: { ...done, verdict: 'pass' }, accept: done,
  }
  // The step asks tier.standard (workflows/research.yaml, WW8b): a run dispatched without a tier is of an older series.
  const events: Record<string, unknown>[] = [{ type: 'admitted', at, input, worker: account }, { type: 'dispatched', stepId: 'investigate', at, capability: 'research,web-search,tier.standard' }]
  if (stage === 'investigate') {
    steps.investigate = { state: 'failed', outputs: {} }
    events.push({ type: 'observed', stepId: 'investigate', status: 'failed', at, reason })
  } else if (stage === 'citations') {
    steps.citations!.verdict = 'inconclusive'
    events.push({ type: 'verified', stepId: 'citations', verdict: 'inconclusive', at, reason })
  } else if (stage) steps[stage] = { state: 'failed', outputs: {} }
  const why = stage === 'investigate' ? 'step investigate failed' : reason
  if (outcome !== 'running') events.push({ type: 'terminal', at: end, outcome, reason: why ?? '' })
  return { events, state: { status: outcome, steps, reason: outcome === 'running' ? undefined : why } }
}

function setup(works: Record<string, unknown>, script: Record<string, { id: string; record: unknown }[]> = {}, artifacts: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-fake-'))
  const bin = join(dir, 'system')
  writeFileSync(bin, fake)
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'db.json'), JSON.stringify({ workers: WEB, task: TASK, oldTask: OLD_TASK, works, script, artifacts }))
  const env = { SYSTEM_BIN: bin, FAKE_DB: join(dir, 'db.json'), FAKE_CALLS: join(dir, 'calls.json') }
  const calls = () => JSON.parse(readFileSync(env.FAKE_CALLS, 'utf8')) as string[][]
  return { dir, env, calls }
}

test('a run submits the canary once to each chatgpt-web Account, one after the other, and prints a line per Work', { timeout: 60_000 }, () => {
  const t = '2026-11-08T00:00:00.000Z'
  const s = setup({}, {
    'web/chatgpt/a': [{ id: 'work:1', record: record('web/chatgpt/a', t, 42.5, 'succeeded') }],
    'web/chatgpt/b': [{ id: 'work:2', record: record('web/chatgpt/b', t, 7, 'failed', 'investigate', 'the answer never stabilised') }],
  })
  try {
    const ran = run([], s.env)
    assert.equal(ran.status, 0, ran.stderr)
    assert.deepEqual(ran.stdout.trim().split('\n').map((l) => l.split(/\s+/)), [['web/chatgpt/a', 'work:1', 'succeeded', '42.5'], ['web/chatgpt/b', 'work:2', 'failed', '7.0']])
    const submits = s.calls().filter((c) => c[0] === 'work' && c[1] === 'submit')
    assert.equal(submits.length, 2)
    for (const [i, ref] of ['web/chatgpt/a', 'web/chatgpt/b'].entries()) {
      const args = submits[i]!
      assert.equal(args[args.indexOf('--worker') + 1], ref)
      assert.equal(args[args.indexOf('--input') + 1], TASK)
      assert.match(args[args.indexOf('--workflow') + 1]!, /workflows\/research\.yaml$/)
    }
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('the report classifies each run, counts the Worker step apart, and holds the gate at 50 passing runs and 95%', { timeout: 60_000 }, () => {
  const works: Record<string, unknown> = {}
  const at = (n: number) => new Date(Date.parse('2026-11-01T00:00:00Z') + n * 3600_000).toISOString()
  let n = 0
  // a: 25 runs, 24 pass, one held by the verifier; b: 25 runs, 24 pass, one Worker step failure.
  for (const account of ['web/chatgpt/a', 'web/chatgpt/b']) {
    for (let i = 0; i < 25; i++) {
      works[`work:${n}`] = i !== 12 ? record(account, at(n), 5, 'succeeded')
        : account.endsWith('a') ? record(account, at(n), 5, 'held', 'citations', '0 of 1 confirmed: s1 (HTTP 403, quote unreadable)')
        : record(account, at(n), 5, 'failed', 'investigate', 'timed out')
      n++
    }
  }
  works['work:old'] = record('web/chatgpt/a', at(1), 5, 'failed', 'investigate', 'x', 'sha256:' + 'f'.repeat(64))
  works['work:inflight'] = record('web/chatgpt/a', at(60), 0, 'running')
  const s = setup(works)
  try {
    const all = run(['--report'], s.env)
    assert.equal(all.status, 0, all.stdout + all.stderr)
    assert.match(all.stdout, /web\/chatgpt\/a\s+runs 25\s+passed 24 \(96\.0%\)\s+worker step ok 25 \(100\.0%\)\s+worker-failed 0\s+verifier 1\s+other 0/)
    assert.match(all.stdout, /web\/chatgpt\/b\s+runs 25\s+passed 24 \(96\.0%\)\s+worker step ok 24 \(96\.0%\)\s+worker-failed 1\s+verifier 0\s+other 0/)
    assert.match(all.stdout, /total\s+runs 50\s+passed 48 \(96\.0%\)\s+worker step ok 49 \(98\.0%\)\s+worker-failed 1\s+verifier 1\s+other 0/)
    assert.match(all.stdout, /work:12 {2}web\/chatgpt\/a {2}verifier: 0 of 1 confirmed: s1 \(HTTP 403, quote unreadable\)/)
    assert.match(all.stdout, /work:37 {2}web\/chatgpt\/b {2}worker-failed: investigate: timed out/)
    assert.match(all.stdout, /gate: holds/)
    // --since drops the older runs: too few remain.
    const since = run(['--report', '--since', at(30)], s.env)
    assert.equal(since.status, 3, since.stdout)
    assert.match(since.stdout, /total\s+runs 20 /)
    assert.match(since.stdout, /gate: does not hold \(20 of 50 runs; only 1 Account\)/)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('the report counts site errors apart from other Worker step failures', { timeout: 60_000 }, () => {
  const t = '2026-11-02T00:00:00Z'
  const s = setup({
    'work:1': record('web/chatgpt/a', t, 1, 'failed', 'investigate', 'site error: This response couldn’t load'),
    'work:2': record('web/chatgpt/a', t, 1, 'failed', 'investigate', 'no answer within the time limit'),
    'work:3': record('web/chatgpt/a', t, 1, 'failed', 'accept', 'denied'),
    'work:4': record('web/chatgpt/a', t, 1, 'succeeded'),
  })
  try {
    const ran = run(['--report'], s.env)
    assert.match(ran.stdout, /total\s+runs 4\s+passed 1 \(25\.0%\)\s+worker step ok 2 \(50\.0%\)\s+worker-failed 2 \(site error 1\)\s+verifier 0\s+other 1/)
    assert.match(ran.stdout, /work:1 {2}web\/chatgpt\/a {2}worker-failed: investigate: site error: This response couldn’t load/)
    assert.match(ran.stdout, /work:3 {2}web\/chatgpt\/a {2}other: accept: denied/)
    assert.match(ran.stdout, /gate: does not hold \(4 of 50 runs; 25\.0% passed, needs 95%; only 1 Account\)/)
    assert.match(ran.stdout, /worker step: 50\.0% ok/)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('the report prints a long reason only up to 200 characters', { timeout: 60_000 }, () => {
  const t = '2026-11-02T00:00:00Z'
  const long = `the Worker threw: ui-map@1.0: ${'data must NOT have additional properties, '.repeat(40)}`
  const s = setup({ 'work:1': record('web/chatgpt/a', t, 1, 'failed', 'investigate', long) })
  try {
    const line = run(['--report'], s.env).stdout.split('\n').find((l) => l.includes('work:1'))!
    const detail = line.slice(line.indexOf('worker-failed: ') + 'worker-failed: '.length)
    assert.equal(detail, `investigate: ${long}`.slice(0, 200) + '…')
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('the report prints the median and p95 of the launch and wait stages per Account from the evidence', { timeout: 60_000 }, () => {
  const t = '2026-11-02T00:00:00Z'
  const works: Record<string, unknown> = {}
  const artifacts: Record<string, string> = {}
  // Launch 1..5 s and wait 10..50 s on one Account; a run with no evidence on the other.
  for (let i = 1; i <= 5; i++) {
    const r = record('web/chatgpt/a', t, 1, 'succeeded') as { state: { steps: Record<string, Record<string, unknown>> } }
    r.state.steps.investigate!.partial = { evidence: `sha256:e${i}` }
    works[`work:${i}`] = r
    artifacts[`sha256:e${i}`] = JSON.stringify({ stages: [{ stage: 'launch', status: 'ok', elapsedMs: i * 1000 }, { stage: 'wait', status: 'ok', elapsedMs: i * 10_000 }, { stage: 'close', status: 'ok', elapsedMs: 5 }] })
  }
  works['work:6'] = record('web/chatgpt/b', t, 1, 'succeeded')
  const s = setup(works, {}, artifacts)
  try {
    const ran = run(['--report'], s.env)
    assert.match(ran.stdout, /web\/chatgpt\/a\s+launch 3\.0 \/ 5\.0 \(n 5\)\s+wait 30\.0 \/ 50\.0 \(n 5\)/)
    assert.match(ran.stdout, /web\/chatgpt\/b\s+launch -\s+wait -\s+\(1 without evidence\)/)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('the report counts the distinct model and Power per Account (WW8a), unread ones apart', { timeout: 60_000 }, () => {
  const t = '2026-11-02T00:00:00Z'
  const works: Record<string, unknown> = {}
  const artifacts: Record<string, string> = {}
  const seen = [['Latest', 'Instant'], ['Latest', 'Instant'], ['Latest', 'High'], [null, null], undefined]
  seen.forEach((evidence, i) => {
    const r = record('web/chatgpt/a', t, 1, 'succeeded') as { state: { steps: Record<string, Record<string, unknown>> } }
    r.state.steps.investigate!.partial = { evidence: `sha256:e${i}` }
    works[`work:${i}`] = r
    artifacts[`sha256:e${i}`] = JSON.stringify({ stages: [], ...(evidence ? { model: evidence[0], power: evidence[1] } : {}) })
  })
  const s = setup(works, {}, artifacts)
  try {
    const ran = run(['--report'], s.env)
    assert.match(ran.stdout, /web\/chatgpt\/a\s+model Latest 3, unread 2\s+power before unread 5\s+power High 1, Instant 2, unread 2\s+target unread 5/)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('the report shows the Power before and after selection and the target per Account (WW8b)', { timeout: 60_000 }, () => {
  const t = '2026-11-02T00:00:00Z'
  const works: Record<string, unknown> = {}
  const artifacts: Record<string, string> = {}
  const seen = [['Instant', 'Medium'], ['Instant', 'Medium'], ['High', 'Medium']]
  seen.forEach(([before, after], i) => {
    const r = record('web/chatgpt/a', t, 1, 'succeeded') as { state: { steps: Record<string, Record<string, unknown>> } }
    r.state.steps.investigate!.partial = { evidence: `sha256:e${i}` }
    works[`work:${i}`] = r
    artifacts[`sha256:e${i}`] = JSON.stringify({ stages: [], model: 'Latest', powerBefore: before, power: after, powerTarget: 'standard', powerLevels: 5 })
  })
  const s = setup(works, {}, artifacts)
  try {
    const ran = run(['--report'], s.env)
    assert.match(ran.stdout, /web\/chatgpt\/a\s+model Latest 3\s+power before High 1, Instant 2\s+power Medium 3\s+target standard 3/)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

// Changing the canary to tier.standard starts a new series: the Task text is the same, so the runs are told apart by their target.
test('runs of the canary Task before it asked tier.standard, or at another target, are an older series outside the gate', { timeout: 60_000 }, () => {
  const t = '2026-11-02T00:00:00Z'
  const untiered = record('web/chatgpt/a', t, 1, 'succeeded') as { events: Record<string, unknown>[] }
  untiered.events = untiered.events.filter((e) => e.type !== 'dispatched')
  const economy = record('web/chatgpt/b', t, 1, 'succeeded') as { state: { steps: Record<string, Record<string, unknown>> } }
  economy.state.steps.investigate!.partial = { evidence: 'sha256:eco' }
  const s = setup({
    'work:1': record('web/chatgpt/a', t, 1, 'succeeded'),
    'work:2': untiered,
    'work:3': economy,
  }, {}, { 'sha256:eco': JSON.stringify({ stages: [], powerTarget: 'economy' }) })
  try {
    const ran = run(['--report'], s.env)
    const [current, older] = ran.stdout.split('older canary version')
    assert.match(current!, /total\s+runs 1\s+passed 1 /)
    assert.match(older!, /total\s+runs 2\s+passed 2 /)
    assert.match(ran.stdout, /gate: does not hold \(1 of 50 runs; only 1 Account\)/)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('the report shows the older canary version apart and the gate counts only the current one', { timeout: 60_000 }, () => {
  const t = '2026-11-02T00:00:00Z'
  const s = setup({
    'work:1': record('web/chatgpt/a', t, 1, 'succeeded'),
    'work:2': record('web/chatgpt/a', t, 1, 'held', 'citations', '0 of 1 confirmed: s1 (HTTP 403, quote unreadable)', OLD_TASK),
    'work:3': record('web/chatgpt/b', t, 1, 'succeeded', undefined, undefined, OLD_TASK),
  })
  try {
    const ran = run(['--report'], s.env)
    const [current, older] = ran.stdout.split('older canary version')
    assert.match(current!, /total\s+runs 1\s+passed 1 /)
    assert.doesNotMatch(current!, /HTTP 403/)
    assert.match(older!, /total\s+runs 2\s+passed 1 /)
    assert.match(older!, /work:2 {2}web\/chatgpt\/a {2}verifier: 0 of 1 confirmed/)
    assert.match(ran.stdout, /gate: does not hold \(1 of 50 runs; only 1 Account\)/)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('the report exits 1 when System cannot be run', { timeout: 60_000 }, () => {
  assert.equal(run(['--report'], { SYSTEM_BIN: '/nonexistent/system' }).status, 1)
})

test('the systemd units run the tool every six hours, randomised and persistent', () => {
  const unit = (name: string) => readFileSync(join(repo, 'packages', 'bundle', name), 'utf8')
  assert.match(unit('system-web-canary.service'), /^ExecStart=@NODE@ @REPO@\/tools\/web-canary$/m)
  assert.match(unit('system-web-canary.service'), /^Type=oneshot$/m)
  const timer = unit('system-web-canary.timer')
  assert.match(timer, /^OnCalendar=\*-\*-\* 00\/6:00:00$/m)
  assert.match(timer, /^RandomizedDelaySec=\d+/m)
  assert.match(timer, /^Persistent=true$/m)
})

// WW-rename: old Work records keep their refs; the report counts `chatgpt-web/<name>` and `web/chatgpt/<name>` as one Account.
test('the report counts an Account\'s old chatgpt-web ref and its web/chatgpt ref as one Account, named by the new ref', { timeout: 60_000 }, () => {
  const t = '2026-11-08T00:00:00.000Z'
  const s = setup({
    'work:1': record('chatgpt-web/a', t, 1, 'succeeded'),
    'work:2': record('web/chatgpt/a', t, 1, 'succeeded'),
    'work:3': record('chatgpt-web/b', t, 1, 'failed', 'investigate', 'timed out'),
  })
  try {
    const ran = run(['--report'], s.env)
    assert.match(ran.stdout, /^web\/chatgpt\/a\s+runs 2\s+passed 2 /m)
    assert.match(ran.stdout, /^web\/chatgpt\/b\s+runs 1\s+passed 0 /m)
    assert.doesNotMatch(ran.stdout, /^chatgpt-web\//m)
    assert.match(ran.stdout, /work:3 {2}web\/chatgpt\/b {2}worker-failed/, 'the failed run is listed under the new ref')
    assert.match(ran.stdout, /gate: does not hold \(3 of 50 runs; 66\.7% passed, needs 95%\)/, 'two Accounts, so no Account problem')
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})
