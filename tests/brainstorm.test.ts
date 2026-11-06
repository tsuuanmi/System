/**
 * Brainstorm (PLAN.md B1, and the B2 recovery checks that need no model) on
 * the real profile: the bundle's own accounts, with only their CLI pointed at
 * the fake (packages/agents/tests/fake-agent.mjs). Two proposals from the
 * brief alone on different providers, then a synthesis of both exact
 * proposal Artifacts; no verifier.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-brainstorm')
const { home, env } = cli
const BRAINSTORM = join(repo, 'workflows', 'brainstorm.yaml')
const system = (args: string[], input?: string) => cli.run(args, { input })

type Account = { ref: string; runtime: string; capabilities: string[]; command?: string }
const yaml = createRequire(join(repo, 'packages', 'work', 'package.json'))('yaml') as { parse(text: string, options: { logLevel: 'error' }): unknown }
const bundle = yaml.parse(readFileSync(join(repo, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as { insert: { id: string; config?: { accounts?: Account[] } }[] }[]
const accounts = bundle[0]!.insert.find((row) => row.id === 'agents')!.config!.accounts!

type Event = { type: string; seq: number; stepId?: string; selected?: string; inputs?: Record<string, string>; status?: string; outputs?: Record<string, string> }
type WorkView = { events: Event[]; state: { status: string; reason?: string; specId: string; steps: Record<string, { state: string; outputs: Record<string, string> }> } }
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as WorkView
/** Who produced an Artifact, in which Work: its recorded occurrences. */
const producers = (id: string) => (JSON.parse(system(['artifact', 'show', id]).stdout) as { occurrences: { producer: { ref: string }; workId?: string }[] }).occurrences.map((o) => [o.producer.ref, o.workId])
const text = (id: string) => system(['artifact', 'cat', id]).stdout
const dispatched = (record: WorkView) => record.events.filter((e) => e.type === 'dispatched')

function brief(markers: string) {
  const out = system(['task', 'new', '--text', `How should System schedule Work? ${markers}`])
  assert.equal(out.status, 0, out.stderr)
  return out.stdout.trim().split('\n').at(-1)!
}

before(() => {
  assert.equal(system(['init']).status, 0)
  // JSON is YAML: the bundle's accounts as they are, each running the fake CLI.
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents\n  config: ${JSON.stringify({ accounts: accounts.map((a) => ({ ...a, command: fakeAgent })) })}\n`)
  assert.equal(system(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], 'fake-token\n').status, 0)
  mkdirSync(join(home, 'system', 'codex', 'default'), { recursive: true })
  writeFileSync(join(home, 'system', 'codex', 'default', 'auth.json'), '{}')
})

after(() => rmSync(home, { recursive: true, force: true }))

test('the bundle gives each Brainstorm role to one provider: the two proposals never share one', () => {
  const holders = (role: string) => accounts.filter((a) => a.capabilities.includes(role)).map((a) => a.runtime)
  assert.deepEqual(holders('brainstorm.idea-a'), ['claude-code'])
  assert.deepEqual(holders('brainstorm.idea-b'), ['codex'])
  assert.equal(holders('brainstorm.synthesis').length, 1)
})

test('a brief yields two independent proposals and a synthesis of exactly those two, by three attempts', () => {
  const input = brief('FAKE:outputs FAKE:sign')
  const ran = system(['work', 'submit', '--workflow', BRAINSTORM, '--input', input])
  assert.equal(ran.status, 0, ran.stderr)
  const record = show(ran.stdout.trim())
  assert.equal(record.state.status, 'succeeded')
  assert.deepEqual(dispatched(record).map((e) => [e.stepId, e.selected]), [
    ['idea-a', 'claude-code/default'], ['idea-b', 'codex/default'], ['synthesis', 'claude-code/default'],
  ])
  const a = record.state.steps['idea-a']!.outputs.proposal!
  const b = record.state.steps['idea-b']!.outputs.proposal!
  const summary = record.state.steps.synthesis!.outputs.summary!
  assert.notEqual(a, b)
  assert.deepEqual(dispatched(record).map((e) => e.inputs), [
    { brief: input }, { brief: input }, { brief: input, 'proposal-a': a, 'proposal-b': b },
  ])
  const workId = ran.stdout.trim()
  assert.deepEqual([a, b, summary].map(producers), [[['claude-code/default', workId]], [['codex/default', workId]], [['claude-code/default', workId]]])
  assert.equal(text(a), '# proposal by claude')
  assert.equal(text(b), '# proposal by codex')
  assert.equal(text(summary), `# summary by claude\n## proposal-a\n${text(a)}\n## proposal-b\n${text(b)}`)
  assert.ok(record.events.every((e) => e.type !== 'verified'), 'no verifier runs')
  assert.equal(system(['work', 'replay', workId]).status, 0)
})

test('without a Codex account the Work is refused before any Worker runs: no same-provider substitute', () => {
  const noCodex = join(home, 'no-codex.yml')
  writeFileSync(noCodex, `- id: agents\n  config: ${JSON.stringify({ accounts: accounts.filter((a) => a.runtime !== 'codex').map((a) => ({ ...a, command: fakeAgent })) })}\n`)
  const before = system(['work', 'list']).stdout.trim().split('\n').filter(Boolean).length
  const ran = system(['--patch', noCodex, 'work', 'submit', '--workflow', BRAINSTORM, '--input', brief('FAKE:outputs')])
  assert.equal(ran.status, 1)
  assert.match(ran.stderr, /step idea-b needs Worker capability brainstorm\.idea-b, which no enabled Worker provides/)
  assert.equal(ran.stdout.trim(), '')
  assert.equal(system(['work', 'list']).stdout.trim().split('\n').filter(Boolean).length, before, 'no Work was admitted')
})

test('a stop after the first proposal reuses it: the retry runs only the second proposal and the synthesis', async () => {
  const marker = join(home, `hang-${Date.now()}`)
  const input = brief(`FAKE:outputs FAKE:sign FAKE:hang=idea-b:${marker}`)
  const submit = spawn(process.execPath, [join(repo, 'bin', 'system'), 'work', 'submit', '--workflow', BRAINSTORM, '--input', input], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  submit.stdout.on('data', (d) => { out += d })
  const exited = new Promise<number | null>((resolve) => submit.on('close', resolve))
  let workId = ''
  for (let i = 0; i < 200 && !workId; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (out.trim()) workId = out.trim().split('\n')[0]!
  }
  assert.ok(workId, 'the submit printed its Work ID')
  for (let i = 0; i < 300 && !dispatched(show(workId)).some((e) => e.stepId === 'idea-b'); i++) await new Promise((r) => setTimeout(r, 100))
  const first = show(workId).state.steps['idea-a']!.outputs.proposal!
  assert.ok(first, 'idea-a finished before idea-b started')

  assert.equal(system(['work', 'cancel', workId, '--reason', 'stop after the first idea', '--wait']).status, 0)
  assert.equal(await exited, 5)
  assert.equal(show(workId).state.status, 'cancelled')

  const retried = system(['work', 'retry', workId, '--reason', 'resume'])
  assert.equal(retried.status, 0, retried.stderr)
  const done = show(workId)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(dispatched(done).map((e) => [e.stepId, e.selected]), [
    ['idea-a', 'claude-code/default'], ['idea-b', 'codex/default'], ['idea-b', 'codex/default'], ['synthesis', 'claude-code/default'],
  ])
  assert.equal(done.state.steps['idea-a']!.outputs.proposal, first, 'the first proposal is the same Artifact, not generated again')
  assert.equal(dispatched(done).at(-1)!.inputs!['proposal-a'], first)
  assert.equal(system(['work', 'replay', workId]).status, 0)
})

test('after a host is killed mid-step, four hosts resuming at once dispatch the lost step once, losing no event', async () => {
  const marker = join(home, `hang-kill-${Date.now()}`)
  const input = brief(`FAKE:outputs FAKE:sign FAKE:hang=idea-b:${marker}`)
  const submit = spawn(process.execPath, [join(repo, 'bin', 'system'), 'work', 'submit', '--workflow', BRAINSTORM, '--input', input], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  submit.stdout.on('data', (d) => { out += d })
  const exited = new Promise<number | null>((resolve) => submit.on('close', resolve))
  let workId = ''
  for (let i = 0; i < 200 && !workId; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (out.trim()) workId = out.trim().split('\n')[0]!
  }
  assert.ok(workId, 'the submit printed its Work ID')
  for (let i = 0; i < 300 && !dispatched(show(workId)).some((e) => e.stepId === 'idea-b'); i++) await new Promise((r) => setTimeout(r, 100))
  const lock = join(home, 'system', 'control', `${workId.replace(/[^a-z0-9-]/gi, '_')}.lock`)
  // The lock holds `<pid> <start time>`.
  process.kill(Number(readFileSync(lock, 'utf8').split(' ')[0]), 'SIGKILL')
  assert.notEqual(await exited, 0, 'the killed host did not finish the Work')

  const runs = await Promise.all([0, 1, 2, 3].map(() => new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [join(repo, 'bin', 'system'), 'work', 'run', workId], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stderr }))
  })))
  const winners = runs.filter((r) => r.status === 0)
  assert.equal(winners.length, 1, JSON.stringify(runs))
  for (const loser of runs.filter((r) => r.status !== 0)) assert.match(loser.stderr, /is being run by/)
  const done = show(workId)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(dispatched(done).map((e) => e.stepId), ['idea-a', 'idea-b', 'idea-b', 'synthesis'])
  assert.deepEqual(done.events.filter((e) => e.type === 'attempt-lost').map((e) => e.stepId), ['idea-b'])
  assert.deepEqual(done.events.map((e) => e.seq), done.events.map((_, i) => i), 'every event kept, in order')
  assert.equal(system(['work', 'replay', workId]).status, 0)
})

test('editing the Workflow file after admission changes nothing for an admitted Work', () => {
  const copy = join(home, 'brainstorm-copy.yaml')
  writeFileSync(copy, readFileSync(BRAINSTORM, 'utf8'))
  const ran = system(['work', 'submit', '--workflow', copy, '--input', brief('FAKE:outputs FAKE:fail')])
  assert.equal(ran.status, 1)
  const workId = ran.stdout.trim()
  const pinned = show(workId).state.specId
  writeFileSync(copy, readFileSync(BRAINSTORM, 'utf8').replace('id: synthesis', 'id: merge'))
  system(['work', 'retry', workId, '--reason', 'again'])
  const after = show(workId)
  assert.equal(after.state.specId, pinned)
  assert.deepEqual(Object.keys(after.state.steps), ['idea-a', 'idea-b', 'synthesis'])
})
