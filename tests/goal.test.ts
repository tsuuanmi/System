/**
 * ADR-0009 O1 on the real profile: `system goal new` behind a terminal
 * confirmation, a Work admitted under the Goal (its context reaches the
 * Worker), the budget refusal at the limit, and a raise. Workers run on the
 * fake CLI.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-goal')
const { home, env } = cli
const system = (args: string[], input?: string) => cli.run(args, { input })
const hasScript = spawnSync('script', ['--version']).status === 0

/** Run `system` on a real pseudo-terminal, typing `input`. */
function onTerminal(args: string[], input: string) {
  const command = [process.execPath, join(repo, 'bin', 'system'), ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
  return spawnSync('script', ['-qec', command, '/dev/null'], { env: { ...env, SYSTEM_CALLER: '' }, input, encoding: 'utf8', timeout: 180_000 })
}
const last = (text: string) => text.trim().split(/\r?\n/).at(-1)!

before(async () => {
  assert.equal(system(['init']).status, 0)
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
  assert.equal(system(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], 'fake-token\n').status, 0)
  await cli.start()
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

test('a Goal is written by a human at a terminal, its budget limits admission, and a raise lets it go on', { skip: !hasScript && 'needs script(1) for a pseudo-terminal', timeout: 240_000 }, () => {
  const args = ['goal', 'new', '--aim', 'ship O1', '--scope', 'the work row only', '--attempts', '1']
  const piped = system(args)
  assert.equal(piped.status, 1)
  assert.match(piped.stderr, /needs a human at a terminal/)
  const agent = cli.run(args, { env: { SYSTEM_CALLER: 'agent' } })
  assert.equal(agent.status, 1)
  const wrong = onTerminal(args, 'not-it\n')
  assert.notEqual(wrong.status, 0)
  assert.match(wrong.stdout, /Nothing is stored unless you type exactly ([0-9a-f]{8})/)
  assert.equal(system(['work', 'list']).stdout.trim(), '')

  const asked = onTerminal(args, '\n')
  const short = asked.stdout.match(/type exactly ([0-9a-f]{8})/)![1]!
  const made = onTerminal(args, `${short}\n`)
  assert.equal(made.status, 0, made.stdout)
  const goal = last(made.stdout)
  assert.match(goal, /^sha256:[0-9a-f]{64}$/)

  const shown = JSON.parse(system(['goal', 'show', goal]).stdout) as { goal: { budget: unknown; context: string[] }; current: { id: string }; spend: { attempts: number } }
  assert.deepEqual(shown.goal.budget, { attempts: 1 })
  assert.equal(shown.current.id, goal)
  assert.match(system(['artifact', 'cat', shown.goal.context[0]!]).stdout, /Product Charter|Charter/, 'the Charter is the default context')

  const task = last(system(['task', 'new', '--text', 'FAKE:outputs FAKE:sign Do it.']).stdout)
  const ran = system(['work', 'submit', '--capability', 'research', '--input', task, '--goal', goal])
  assert.equal(ran.status, 0, ran.stderr)
  const record = JSON.parse(system(['work', 'show', ran.stdout.trim()]).stdout) as { state: { steps: { task: { outputs: { result: string } } } } }
  const seen = system(['artifact', 'cat', record.state.steps.task.outputs.result]).stdout
  assert.match(seen, /## context-1\n/, 'the Goal context reached the Worker')
  const report = JSON.parse(system(['work', 'report', ran.stdout.trim()]).stdout) as { goal: { spend: { attempts: number }; budget: unknown } }
  assert.deepEqual([report.goal.spend.attempts, report.goal.budget], [1, { attempts: 1 }])

  const refused = system(['work', 'submit', '--capability', 'research', '--input', task, '--goal', goal])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /budget of Goal .* is used up/)

  const raise = onTerminal(['goal', 'new', '--aim', 'ship O1', '--scope', 'the work row only', '--attempts', '2', '--supersedes', goal], '\n')
  const raiseShort = raise.stdout.match(/type exactly ([0-9a-f]{8})/)![1]!
  const raised = last(onTerminal(['goal', 'new', '--aim', 'ship O1', '--scope', 'the work row only', '--attempts', '2', '--supersedes', goal], `${raiseShort}\n`).stdout)
  assert.equal((JSON.parse(system(['goal', 'show', goal]).stdout) as { current: { id: string } }).current.id, raised)
  assert.equal(system(['work', 'submit', '--capability', 'research', '--input', task, '--goal', goal]).status, 0)
})
