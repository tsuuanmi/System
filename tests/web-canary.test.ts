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
  assert.match(cli.run(['artifact', 'show', id]).stdout, /capital of France/)
})

test('work submit --worker is refused for a Worker that is not registered', { timeout: 120_000 }, () => {
  const task = run(['--task']).stdout.trim()
  const refused = cli.run(['work', 'submit', '--capability', 'research', '--input', task, '--worker', 'chatgpt-web/nobody', '--no-run'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /no enabled Worker chatgpt-web\/nobody/)
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
else if (a === 'task') process.stdout.write(db.task + '\\n')
else if (a === 'work' && b === 'list') for (const [id, r] of Object.entries(db.works)) process.stdout.write(id + '  ' + r.state.status.padEnd(9) + '  sha256:spec\\n')
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
const WEB = ['registered: chatgpt-web/a, chatgpt-web/b, claude-code/default',
  'chatgpt-web/a   available   (chatgpt-web)',
  'chatgpt-web/b   available   (chatgpt-web)',
  'chatgpt-web/c   unavailable - no sign-in (chatgpt-web)',
  'claude-code/default available 2.1.0 (claude-code)', ''].join('\n')

/** A Work record as `work show` prints it, reduced to what the canary reads. */
function record(account: string, at: string, seconds: number, outcome: 'succeeded' | 'failed' | 'running', stage?: string, reason?: string, input = TASK) {
  const end = new Date(Date.parse(at) + seconds * 1000).toISOString()
  const steps: Record<string, { state: string }> = { investigate: { state: 'succeeded' }, citations: { state: 'succeeded' }, accept: { state: 'succeeded' } }
  if (stage) steps[stage] = { state: 'failed' }
  return {
    events: [{ type: 'admitted', at, input, worker: account }, ...(outcome === 'running' ? [] : [{ type: 'terminal', at: end, outcome, reason: reason ?? '' }])],
    state: { status: outcome, steps, reason },
  }
}

function setup(works: Record<string, unknown>, script: Record<string, { id: string; record: unknown }[]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'canary-fake-'))
  const bin = join(dir, 'system')
  writeFileSync(bin, fake)
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'db.json'), JSON.stringify({ workers: WEB, task: TASK, works, script }))
  const env = { SYSTEM_BIN: bin, FAKE_DB: join(dir, 'db.json'), FAKE_CALLS: join(dir, 'calls.json') }
  const calls = () => JSON.parse(readFileSync(env.FAKE_CALLS, 'utf8')) as string[][]
  return { dir, env, calls }
}

test('a run submits the canary once to each chatgpt-web Account, one after the other, and prints a line per Work', { timeout: 60_000 }, () => {
  const t = '2026-11-08T00:00:00.000Z'
  const s = setup({}, {
    'chatgpt-web/a': [{ id: 'work:1', record: record('chatgpt-web/a', t, 42.5, 'succeeded') }],
    'chatgpt-web/b': [{ id: 'work:2', record: record('chatgpt-web/b', t, 7, 'failed', 'investigate', 'the answer never stabilised') }],
  })
  try {
    const ran = run([], s.env)
    assert.equal(ran.status, 0, ran.stderr)
    assert.deepEqual(ran.stdout.trim().split('\n').map((l) => l.split(/\s+/)), [['chatgpt-web/a', 'work:1', 'succeeded', '42.5'], ['chatgpt-web/b', 'work:2', 'failed', '7.0']])
    const submits = s.calls().filter((c) => c[0] === 'work' && c[1] === 'submit')
    assert.equal(submits.length, 2)
    for (const [i, ref] of ['chatgpt-web/a', 'chatgpt-web/b'].entries()) {
      const args = submits[i]!
      assert.equal(args[args.indexOf('--worker') + 1], ref)
      assert.equal(args[args.indexOf('--input') + 1], TASK)
      assert.match(args[args.indexOf('--workflow') + 1]!, /workflows\/research\.yaml$/)
    }
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
})

test('the report counts per Account and in total, names the first failing stage, and holds the gate at 50 runs and 95%', { timeout: 60_000 }, () => {
  const works: Record<string, unknown> = {}
  const at = (n: number) => new Date(Date.parse('2026-11-01T00:00:00Z') + n * 3600_000).toISOString()
  let n = 0
  // a: 25 runs, 24 accepted, one failing at citations; b: 25 runs, 24 accepted, one failing at investigate.
  for (const account of ['chatgpt-web/a', 'chatgpt-web/b']) {
    for (let i = 0; i < 25; i++) {
      const bad = i === 12
      works[`work:${n}`] = bad
        ? record(account, at(n), 5, 'failed', account.endsWith('a') ? 'citations' : 'investigate', account.endsWith('a') ? 'a quote is not on the page' : 'timed out')
        : record(account, at(n), 5, 'succeeded')
      n++
    }
  }
  works['work:other'] = record('chatgpt-web/a', at(1), 5, 'failed', 'investigate', 'x', 'sha256:' + 'f'.repeat(64))
  works['work:inflight'] = record('chatgpt-web/a', at(60), 0, 'running')
  const s = setup(works)
  try {
    const all = run(['--report'], s.env)
    assert.equal(all.status, 0, all.stdout + all.stderr)
    assert.match(all.stdout, /chatgpt-web\/a\s+runs 25\s+accepted 24\s+failed 1 \(citations: a quote is not on the page\)\s+96\.0%/)
    assert.match(all.stdout, /chatgpt-web\/b\s+runs 25\s+accepted 24\s+failed 1 \(investigate: timed out\)\s+96\.0%/)
    assert.match(all.stdout, /total\s+runs 50\s+accepted 48\s+failed 2 \(citations: a quote is not on the page\)\s+96\.0%/)
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

test('the gate fails on a low pass rate even with enough runs, and on a missing second Account', { timeout: 60_000 }, () => {
  const works: Record<string, unknown> = {}
  for (let i = 0; i < 60; i++) works[`work:${i}`] = i % 10 === 0 ? record('chatgpt-web/a', '2026-11-02T00:00:00Z', 1, 'failed', 'accept', 'denied') : record('chatgpt-web/a', '2026-11-02T00:00:00Z', 1, 'succeeded')
  const s = setup(works)
  try {
    const low = run(['--report'], s.env)
    assert.equal(low.status, 3)
    assert.match(low.stdout, /total\s+runs 60\s+accepted 54\s+failed 6 \(accept: denied\)\s+90\.0%/)
    assert.match(low.stdout, /gate: does not hold \(90\.0% accepted, needs 95%; only 1 Account\)/)
    assert.equal(run(['--report'], { ...s.env, SYSTEM_BIN: '/nonexistent/system' }).status, 1)
  } finally {
    rmSync(s.dir, { recursive: true, force: true })
  }
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
