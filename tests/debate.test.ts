/**
 * Debate (PLAN WW2b) on the real profile with the fake CLI: two Rounds of two
 * independent Workers, then a synthesis of all four Artifacts. Each side keeps
 * its Account across Rounds because the Round 2 steps ask for the Round 1
 * capabilities. Built from existing parts: no engine change.
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-debate')
const { home } = cli
const DEBATE = join(repo, 'workflows', 'experiments', 'debate.yaml')
const system = (args: string[], input?: string) => cli.run(args, { input })

type Account = { ref: string; runtime: string; capabilities: string[]; command?: string }
const yaml = createRequire(join(repo, 'packages', 'work', 'package.json'))('yaml') as { parse(text: string, options: { logLevel: 'error' }): unknown }
const bundle = yaml.parse(readFileSync(join(repo, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as { insert: { id: string; config?: { accounts?: Account[] } }[] }[]
const accounts = bundle[0]!.insert.find((row) => row.id === 'agents')!.config!.accounts!

type Event = { type: string; stepId?: string; selected?: string; inputs?: Record<string, string> }
type WorkView = { events: Event[]; state: { status: string; specId: string; steps: Record<string, { state: string; outputs: Record<string, string> }> } }
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as WorkView
const dispatched = (record: WorkView) => record.events.filter((e) => e.type === 'dispatched')

before(async () => {
  assert.equal(system(['init']).status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents\n  config: ${JSON.stringify({ accounts: accounts.map((a) => ({ ...a, command: fakeAgent })) })}\n`)
  mkdirSync(join(home, 'system', 'codex', 'default'), { recursive: true })
  writeFileSync(join(home, 'system', 'codex', 'default', 'auth.json'), '{}')
  await cli.start()
  assert.equal(system(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], 'fake-token\n').status, 0)
  await cli.start()
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

test('a brief is debated in two Rounds, each side reading the other side\'s exact proposal, then synthesised', { timeout: 120_000 }, () => {
  const made = system(['task', 'new', '--text', 'How should System schedule Work? FAKE:outputs FAKE:sign'])
  assert.equal(made.status, 0, made.stderr)
  const input = made.stdout.trim()
  const ran = system(['work', 'submit', '--workflow', DEBATE, '--input', input])
  assert.equal(ran.status, 0, ran.stderr)
  const workId = ran.stdout.trim()
  const record = show(workId)
  assert.equal(record.state.status, 'succeeded')
  assert.deepEqual(Object.keys(record.state.steps), ['a1', 'b1', 'a2', 'b2', 'synthesis'])

  // Dispatch order: Round 1 (a1, b1), Round 2 (a2, b2), synthesis; each side on its own Account.
  assert.deepEqual(dispatched(record).map((e) => [e.stepId, e.selected]), [
    ['a1', 'claude-code/default'], ['b1', 'codex/default'], ['a2', 'claude-code/default'], ['b2', 'codex/default'], ['synthesis', 'claude-code/default'],
  ])
  const out = (step: string, slot: string) => record.state.steps[step]!.outputs[slot]!
  const [a1, b1, a2, b2] = [out('a1', 'proposal'), out('b1', 'proposal'), out('a2', 'rebuttal'), out('b2', 'rebuttal')]
  const summary = out('synthesis', 'summary')
  assert.equal(new Set([a1, b1, a2, b2, summary]).size, 5)

  const inputsOf = (step: string) => dispatched(record).find((e) => e.stepId === step)!.inputs
  assert.deepEqual(inputsOf('a1'), { brief: input })
  assert.deepEqual(inputsOf('b1'), { brief: input })
  const ids = (inputs: Record<string, string> | undefined) => Object.values(inputs!).sort()
  assert.deepEqual(ids(inputsOf('a2')), [a1, b1, input].sort())
  assert.deepEqual(ids(inputsOf('b2')), [a1, b1, input].sort())
  assert.notDeepEqual(inputsOf('a2'), inputsOf('b2'), 'the roles are swapped: own and other differ')
  assert.deepEqual(ids(inputsOf('synthesis')), [a1, a2, b1, b2, input].sort())

  assert.equal(system(['work', 'replay', workId]).status, 0)
})

test('the Round 1 steps wait for nothing and each Round 2 step waits for both Round 1 steps', () => {
  const spec = yaml.parse(readFileSync(DEBATE, 'utf8'), { logLevel: 'error' }) as { steps: { id: string; dependsOn?: string[]; capabilities?: string[] }[] }
  const step = (id: string) => spec.steps.find((s) => s.id === id)!
  assert.deepEqual([step('a1').dependsOn ?? [], step('b1').dependsOn ?? []], [[], []])
  for (const id of ['a2', 'b2']) assert.deepEqual([...step(id).dependsOn!].sort(), ['a1', 'b1'])
  assert.deepEqual([...step('synthesis').dependsOn!].sort(), ['a1', 'a2', 'b1', 'b2'])
  assert.deepEqual([step('a2').capabilities, step('b2').capabilities], [step('a1').capabilities, step('b1').capabilities])
})
