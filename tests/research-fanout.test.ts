/**
 * Research fan-out (PLAN WW7a) on the real profile with the fake CLI: a plan
 * of two sub-questions, one investigation per Lane, a citation check per Lane,
 * a synthesis of all four Lane Artifacts and a check of the merged sources.
 * Built from existing parts: no engine change. The citation verifier is the
 * real one, against a local HTTP server.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-fanout')
const { home } = cli
const FANOUT = join(repo, 'workflows', 'research-fanout.yaml')
const system = (args: string[], input?: string) => cli.run(args, { input })
let server: ChildProcess
let site = ''

/** The test process blocks in spawnSync while the Host fetches, so the site runs in its own process. */
const SITE = `
const { createServer } = require('node:http')
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<p>System <i>verifies</i> citations exactly.</p>')
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
`

type Account = { ref: string; runtime: string; capabilities: string[]; command?: string; tokenRef?: string }
const yaml = createRequire(join(repo, 'packages', 'work', 'package.json'))('yaml') as { parse(text: string, options: { logLevel: 'error' }): unknown }
const bundle = yaml.parse(readFileSync(join(repo, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as { insert: { id: string; config?: { accounts?: Account[] } }[] }[]
const accounts = bundle[0]!.insert.find((row) => row.id === 'agents')!.config!.accounts!
const claude = accounts.find((a) => a.ref === 'claude-code/default')!

type Event = { type: string; stepId?: string; selected?: string; inputs?: Record<string, string>; subject?: string; verdict?: string }
type WorkView = { events: Event[]; state: { status: string; steps: Record<string, { state: string; outputs: Record<string, string> }> } }
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as WorkView
const dispatched = (record: WorkView) => record.events.filter((e) => e.type === 'dispatched')

function patch(rows: Account[]): void {
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents\n  config: ${JSON.stringify({ accounts: rows.map((a) => ({ ...a, command: fakeAgent })) })}\n`)
}

/**
 * The Workflow file with the fake CLI's markers added to every step's instructions: only the
 * plan step sees the question's text, so the markers cannot ride on it. The Workers then
 * write their outputs and cite the local site.
 */
function markedWorkflow(): string {
  const file = join(home, 'research-fanout.yaml')
  writeFileSync(file, readFileSync(FANOUT, 'utf8').replace(/^( +instructions: (?:&investigate )?\|\n)/gm, `$1      FAKE:outputs FAKE:sign FAKE:cite=${site}/article\n`))
  return file
}

/** Submit the fan-out on a question. */
function run(): { workId: string; input: string; record: WorkView } {
  const made = system(['task', 'new', '--text', 'Why is the sky blue?'])
  assert.equal(made.status, 0, made.stderr)
  const input = made.stdout.trim().split('\n').at(-1)!
  const ran = system(['work', 'submit', '--workflow', markedWorkflow(), '--input', input])
  assert.equal(ran.status, 0, ran.stderr)
  const workId = ran.stdout.trim()
  return { workId, input, record: show(workId) }
}

before(async () => {
  server = spawn(process.execPath, ['-e', SITE], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<string>((r) => server.stdout!.once('data', (d) => r(String(d).trim())))
  site = `http://127.0.0.1:${port}`
  assert.equal(system(['init']).status, 0)
  patch([claude])
  await cli.start()
  assert.equal(system(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], 'fake-token\n').status, 0)
  await cli.start()
})

after(async () => {
  await cli.stop()
  server.kill()
  rmSync(home, { recursive: true, force: true })
})

test('a question is planned, investigated in two Lanes, checked, synthesised and checked again', { timeout: 180_000 }, () => {
  const { workId, input, record } = run()
  assert.equal(record.state.status, 'succeeded')
  assert.deepEqual(Object.keys(record.state.steps), ['plan', 'investigate-a', 'investigate-b', 'citations-a', 'citations-b', 'synthesis', 'citations', 'accept'])

  const out = (step: string, slot: string) => record.state.steps[step]!.outputs[slot]!
  const inputsOf = (step: string) => dispatched(record).find((e) => e.stepId === step)!.inputs
  const ids = (inputs: Record<string, string> | undefined) => Object.values(inputs!).sort()
  assert.deepEqual(inputsOf('plan'), { question: input })
  assert.deepEqual(inputsOf('investigate-a'), { question: out('plan', 'question-a') })
  assert.deepEqual(inputsOf('investigate-b'), { question: out('plan', 'question-b') })
  assert.notEqual(out('plan', 'question-a'), out('plan', 'question-b'))

  const lanes = [out('investigate-a', 'report'), out('investigate-a', 'sources'), out('investigate-b', 'report'), out('investigate-b', 'sources')]
  assert.equal(new Set(lanes).size, 4)
  assert.deepEqual(ids(inputsOf('synthesis')), [...lanes, input].sort())

  // The accept waits for all three verdicts, each on the exact sources it checks.
  const verified = record.events.filter((e) => e.type === 'verified')
  assert.deepEqual(verified.map((e) => e.verdict), ['pass', 'pass', 'pass'])
  assert.deepEqual(verified.map((e) => e.subject).sort(), [out('investigate-a', 'sources'), out('investigate-b', 'sources'), out('synthesis', 'sources')].sort())
  const last = (step: string) => record.events.findLastIndex((e) => e.stepId === step)
  const accepted = record.events.findIndex((e) => e.stepId === 'accept')
  for (const step of ['citations-a', 'citations-b', 'citations']) assert.ok(last(step) < accepted || accepted === -1, `${step} before accept`)

  assert.equal(system(['work', 'replay', workId]).status, 0)
})

test('with each Lane capability on a different Account, the Lanes are dispatched to those two Accounts', { timeout: 180_000 }, async () => {
  const lane = (n: 'a' | 'b') => `research.lane-${n}`
  const base = claude.capabilities.filter((c) => !c.startsWith('research.lane-'))
  // The patch merges into the bundle's accounts by ref (#45): the bundle's Claude keeps its slot first, without the Lanes.
  patch([
    { ...claude, capabilities: base },
    { ...claude, ref: 'claude-code/one', capabilities: [...base, lane('a')] },
    { ...claude, ref: 'claude-code/two', capabilities: [...base, lane('b')] },
  ])
  await cli.start()
  const { record } = run()
  assert.equal(record.state.status, 'succeeded')
  const where = (step: string) => dispatched(record).find((e) => e.stepId === step)!.selected
  assert.equal(where('investigate-a'), 'claude-code/one')
  assert.equal(where('investigate-b'), 'claude-code/two')
})
