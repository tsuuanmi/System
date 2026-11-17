/**
 * cls-1 on the real profile with the optional `classifier` row on (a profile patch) and a fake economy Account
 * (packages/agents/tests/fake-agent.mjs): a Work fails for a reason no rule knows, its failure gets a Classification
 * from the Account that did not fail, and `work report` shows it under the label, marked as classified. With the row
 * off (the bundle's default) the report is as before. No model credentials are used.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, systemCli, type SystemCli } from '../test-support/cli.ts'

const on = systemCli('system-cls-on')
const off = systemCli('system-cls-off')
let repository = ''

const PROFILE = `- id: agents
  config:
    $patch: replace
    accounts:
      - ref: claude-code/default
        runtime: claude-code
        # Only this Account has the capability the failing Work asks for, so the economy Account is never the one that fails.
        capabilities: [develop.implement]
        command: ${fakeAgent}
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN
      - ref: codex/economy
        runtime: codex
        capabilities: []
        command: ${fakeAgent}
        codexHome: codex/economy
        models: { economy: gpt-econ }
`

async function boot(cli: SystemCli, extra: string): Promise<void> {
  assert.equal(cli.run(['init']).status, 0)
  writeFileSync(join(cli.home, 'profiles', 'system', 'cordis.patch.yml'), PROFILE + extra)
  mkdirSync(join(cli.home, 'system', 'codex', 'economy'), { recursive: true })
  writeFileSync(join(cli.home, 'system', 'codex', 'economy', 'auth.json'), '{}')
  await cli.start()
  assert.equal(cli.run(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], { input: 'fake-token\n', terminal: true }).status, 0)
  await cli.start()
}

before(async () => {
  await boot(on, '- id: classifier\n  disabled: false\n')
  await boot(off, '')
  repository = mkdtempSync(join(on.home, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(repository, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
})

after(async () => {
  await Promise.all([on.stop(), off.stop()])
  rmSync(on.home, { recursive: true, force: true })
  rmSync(off.home, { recursive: true, force: true })
})

type Report = { failures: { kind: string; unknown?: true; classified?: { label: string; confidence: number; classification: string } }[]; unknownFailures: number; classifiedFailures?: Record<string, number> }

function failedWork(cli: SystemCli): string {
  const task = cli.run(['task', 'new', '--text', 'FAKE:fail FAKE:cause=load', '--repo', repository])
  assert.equal(task.status, 0, task.stderr)
  const ran = cli.run(['work', 'submit', '--capability', 'develop.implement', '--input', task.stdout.trim()])
  assert.equal(ran.status, 1)
  return ran.stdout.trim()
}
const report = (cli: SystemCli, workId: string, ...more: string[]) => JSON.parse(cli.run(['work', 'report', workId, ...more]).stdout) as Report

test('the classifier row is installed and off by default', () => {
  assert.match(off.run(['--dump-config']).stdout, /- id: classifier\n  name: '@system\/classifier'\n  disabled: true/)
})

test('an unknown failure gets a Classification from the economy Account that did not fail, and the report shows it as classified', { timeout: 120_000 }, () => {
  const workId = failedWork(on)
  const shown = report(on, workId, '--classify')
  assert.equal(shown.unknownFailures, 1)
  const failure = shown.failures.find((f) => f.unknown)!
  assert.equal(failure.classified?.label, 'load')
  assert.equal(failure.classified?.confidence, 1)
  assert.deepEqual(shown.classifiedFailures, { load: 1 })
  const stored = JSON.parse(on.run(['artifact', 'show', failure.classified!.classification]).stdout) as { envelope: { kind: string; content: { samples: { ref: string; model: string }[] } } }
  assert.equal(stored.envelope.kind, 'classification')
  assert.deepEqual(stored.envelope.content.samples.map((s) => [s.ref, s.model]), Array(3).fill(['codex/economy', 'gpt-econ']))
  // A second report reads the recorded Classification, with or without --classify.
  assert.deepEqual(report(on, workId), shown)
  assert.deepEqual(report(on, workId, '--classify'), shown)
})

test('a Work that ends is classified by the Host, so a plain report shows it', { timeout: 120_000 }, async () => {
  const task = on.run(['task', 'new', '--text', 'FAKE:fail FAKE:cause=slow-host', '--repo', repository])
  const ran = on.run(['work', 'submit', '--capability', 'develop.implement', '--input', task.stdout.trim()])
  assert.equal(ran.status, 1)
  const workId = ran.stdout.trim()
  // The Host classifies after the terminal event, off the controller's path: wait on the condition, never on time alone.
  const deadline = Date.now() + 90_000
  let plain = report(on, workId)
  while (!plain.classifiedFailures && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    plain = report(on, workId)
  }
  assert.deepEqual(plain.classifiedFailures, { 'slow-host': 1 })
})

test('with the row off the report is as before, and --classify says the row is off', { timeout: 120_000 }, () => {
  const workId = failedWork(off)
  const plain = report(off, workId)
  assert.equal(plain.unknownFailures, 1)
  assert.equal('classifiedFailures' in plain, false)
  assert.equal(plain.failures.some((f) => 'classified' in f), false)
  const ran = off.run(['work', 'report', workId, '--classify'])
  assert.equal(ran.status, 1)
  assert.match(ran.stderr, /the classifier row is disabled/)
})
