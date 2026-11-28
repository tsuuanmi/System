/**
 * WW4: tools/web-canary. The canary Task is stored by a deterministic command
 * (the real Host, no Worker runs). No browser starts and no test reaches the real
 * site, so it runs in `smoke`; the report tests (a fake `system`) are in
 * packages/runtime-web/tests/canary-report.unit.test.ts (web-3a).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const canary = join(repo, 'tools', 'web-canary')
const cli = systemCli('system-canary')
const { home } = cli
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [canary, ...args], { env: { ...process.env, ...cli.env, ...env }, encoding: 'utf8', timeout: 60_000 })

before(async () => {
  assert.equal(cli.run(['init']).status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: runtime-cli
  config:
    accounts:
      - ref: claude-code/default
        runtime: claude-code
        capabilities: [research]
        command: ${fakeAgent}
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN
`)
  await cli.start()
  assert.equal(cli.run(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], { input: 'fake-token\n', terminal: true }).status, 0)
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

