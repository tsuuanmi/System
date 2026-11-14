/**
 * M3 on the real profile with the `agents` row pointed at a fake CLI
 * (packages/agents/tests/fake-agent.mjs) by a profile patch: per-attempt
 * worktrees, cross-process cancel, and a Codex takeover of cancelled Claude
 * work, all through `bin/system`. No model credentials are used.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeCodexHome } from '../test-support/accounts.ts'
import { codexRateLimits, fakeQuotaCli } from '../test-support/quota.ts'
import { fakeAgent, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-agents')
const { home } = cli


const system = (args: string[], input?: string) => cli.run(args, { input })

type Record = { events: { type: string; selected?: string; inputs?: { previous?: string }; worker?: { ref: string; version?: string }; status?: string }[]; state: { status: string; reason?: string; steps: { task: { outputs: { result?: string }; partial?: { result?: string } } } } }
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as Record
const tree = (id: string) => (JSON.parse(system(['artifact', 'show', id]).stdout) as { envelope: { content: { commit: string; parent: string } } }).envelope.content

let gitRepo = ''

before(async () => {
  assert.equal(system(['init']).status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents
  config:
    $patch: replace
    accounts:
      - ref: claude-code/default
        runtime: claude-code
        label: main Claude
        priority: primary
        capabilities: [code-write]
        command: ${fakeAgent}
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN
      - ref: codex/default
        runtime: codex
        capabilities: [code-write]
        command: ${fakeAgent}
        codexHome: codex/default
`)
  mkdirSync(join(home, 'system', 'codex', 'default'), { recursive: true })
  writeFileSync(join(home, 'system', 'codex', 'default', 'auth.json'), '{}')
  // The Host reads its credentials when it starts: store the token, then start it again.
  await cli.start()
  assert.equal(cli.run(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], { input: 'fake-token\n', terminal: true }).status, 0)
  await cli.start()
  gitRepo = mkdtempSync(join(home, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', gitRepo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(gitRepo, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

const newTask = (text: string) => {
  const out = system(['task', 'new', '--text', text, '--repo', gitRepo])
  assert.equal(out.status, 0, out.stderr)
  return out.stdout.trim()
}

test('both configured accounts are registered, with the CLI version', () => {
  const out = system(['workers'])
  assert.match(out.stdout, /registered: claude-code\/default, codex\/default/)
  assert.match(out.stdout, /claude-code\/default\s+available\s+0\.0\.0-fake \(Claude Code\)/)
})

test('a direct Task runs Claude Code in its own worktree and records the exact resulting commit', () => {
  const ran = system(['work', 'submit', '--capability', 'code-write', '--input', newTask('FAKE:edit')])
  assert.equal(ran.status, 0, ran.stderr)
  const record = show(ran.stdout.trim())
  const observed = record.events.find((e) => e.type === 'observed')!
  assert.deepEqual(observed.worker, { ref: 'claude-code/default', account: 'default', command: fakeAgent, version: '0.0.0-fake (Claude Code)', servedModels: ['served-default', 'served-subagent'] })
  const result = tree(record.state.steps.task.outputs.result!)
  assert.equal(execFileSync('git', ['-C', gitRepo, 'show', `${result.commit}:NOTE.md`], { encoding: 'utf8' }), 'edited by claude\n')
  assert.equal(execFileSync('git', ['-C', gitRepo, 'status', '--porcelain'], { encoding: 'utf8' }), '')
})

test('cancel from another process stops the attempt, keeps its partial tree, and Codex takes over', { timeout: 120_000 }, async () => {
  const ready = join(cli.home, 'agent-ready')
  const input = newTask(`FAKE:sleep FAKE:edit FAKE:ready=${ready}`)
  const submit = cli.runAsync(['work', 'submit', '--capability', 'code-write', '--worker', 'claude-code/default', '--input', input])
  // Wait for the Work to be admitted and dispatched.
  let workId = ''
  for (let i = 0; i < 1200 && !workId; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (submit.stdout().trim()) workId = submit.stdout().trim().split('\n')[0]!
  }
  assert.ok(workId, 'the submit printed its Work ID')
  for (let i = 0; i < 1200 && !show(workId).events.some((e) => e.type === 'dispatched'); i++) await new Promise((r) => setTimeout(r, 100))
  // The agent has its SIGTERM handler in place: a cancel before that would leave no partial output.
  for (let i = 0; i < 1200 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 100))
  assert.ok(existsSync(ready), 'the agent is running')

  // A second `work run` is refused while the Host runs the Work.
  const contested = system(['work', 'run', workId])
  assert.equal(contested.status, 1)
  assert.match(contested.stderr, /is already being run/)

  const cancel = cli.run(['work', 'cancel', workId, '--reason', 'switch accounts', '--wait'], { terminal: true })
  assert.equal(cancel.status, 0, cancel.stderr)
  assert.match(cancel.stdout, /cancellation requested from the running host/)
  assert.equal((await submit.done).status, 5, 'the following submit exits 5: cancelled')
  const cancelled = show(workId)
  assert.equal(cancelled.state.status, 'cancelled')
  assert.match(cancelled.state.reason!, /cancelled by human tester: switch accounts/)
  assert.equal(cancelled.events.find((e) => e.type === 'observed')?.status, 'cancelled')
  const partialId = cancelled.state.steps.task.partial!.result!
  const partial = tree(partialId)
  assert.equal(execFileSync('git', ['-C', gitRepo, 'show', `${partial.commit}:PARTIAL.md`], { encoding: 'utf8' }), 'half done\n')

  const retried = system(['work', 'retry', workId, '--worker', 'codex/default', '--reason', 'take over'])
  assert.equal(retried.status, 0, retried.stderr)
  const done = show(workId)
  assert.equal(done.state.status, 'succeeded')
  assert.deepEqual(done.events.filter((e) => e.type === 'dispatched').map((e) => e.selected), ['claude-code/default', 'codex/default'])
  assert.equal(done.events.filter((e) => e.type === 'dispatched')[1]!.inputs!.previous, partialId)
  const final = tree(done.state.steps.task.outputs.result!)
  assert.equal(final.parent, partial.commit, 'Codex started from the partial commit, not a transcript')
  assert.equal(execFileSync('git', ['-C', gitRepo, 'show', `${final.commit}:NOTE.md`], { encoding: 'utf8' }), 'edited by codex\n')
  assert.equal(system(['work', 'replay', workId]).status, 0)
})

test('a retry naming an unknown Worker is refused', () => {
  const ran = system(['work', 'submit', '--capability', 'code-write', '--input', newTask('FAKE:fail')])
  assert.equal(ran.status, 1)
  const workId = ran.stdout.trim()
  const retried = system(['work', 'retry', workId, '--worker', 'nobody/default'])
  assert.equal(retried.status, 1)
  assert.match(retried.stderr, /no enabled Worker nobody\/default/)
})

test('a profile with priority: primary loads, and workers notes that it is ignored', () => {
  const out = system(['workers'])
  assert.match(out.stdout, /claude-code\/default[^\n]*main Claude/)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /claude-code\/default[^\n]*priority is ignored/)
  assert.doesNotMatch(out.stdout, /\[[^\]\n]*\bprimary\b/)
  assert.match(out.stdout, /codex\/default[^\n]*provider account/i)
  assert.doesNotMatch(out.stdout, /fake-token/)
})

test('workers shows each account quota or why its CLI version is unreadable', () => {
  const out = system(['workers'])
  assert.equal(out.status, 0, out.stderr)
  assert.doesNotMatch(out.stdout, /fake-token/)
  const blocks = out.stdout.trimEnd().split(/\n(?=\S)/).slice(1)
  for (const ref of ['claude-code/default', 'codex/default']) {
    const block = blocks.find((line) => line.startsWith(ref))
    assert.ok(block, `${ref} is listed`)
    assert.match(block, /^  quota: unreadable - [^\n]*version/m)
    assert.equal(block.match(/^  quota:/gm)?.length ?? 0, 1)
  }
})

test('duplicate provider account IDs refuse the later account, while unreadable IDs remain registered', async () => {
  const writeAccount = (name: string, accountId?: string) => {
    const dir = join(home, 'system', 'codex', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(accountId ? { tokens: { account_id: accountId } } : {}))
  }
  writeAccount('identity-a', 'same-provider-account')
  writeAccount('identity-b', 'same-provider-account')
  writeAccount('identity-unknown')
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents\n  config:\n    $patch: replace\n    accounts:\n      - {ref: codex/x1, runtime: codex, capabilities: [code-write], command: ${fakeAgent}, codexHome: codex/identity-a}\n      - {ref: codex/x2, runtime: codex, capabilities: [code-write], command: ${fakeAgent}, codexHome: codex/identity-b}\n      - {ref: codex/x3, runtime: codex, capabilities: [code-write], command: ${fakeAgent}, codexHome: codex/identity-unknown}\n`)
  await cli.start()
  const out = system(['workers'])
  assert.match(out.stdout, /codex\/x2[^\n]*codex\/x1[^\n]*provider account/i)
  assert.match(out.stdout, /codex\/x3\s+available/)
})

async function readableQuotaAccount() {
  const codexHome = fakeCodexHome(join(home, 'quota-home'), 'quota-provider')
  const fake = fakeQuotaCli(join(home, 'quota-cli'), { kind: 'codex', version: '0.166.0', answer: codexRateLimits({ primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: null } }) })
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents
  config:
    $patch: replace
    accounts:
      - {ref: codex/quota, runtime: codex, capabilities: [research], command: ${JSON.stringify(fake.command)}, codexHome: ${JSON.stringify(codexHome)}}
      - {ref: web/chatgpt/quota, runtime: web, site: chatgpt, capabilities: [research]}
`)
  await cli.start()
  return fake
}

test('workers shows a readable quota from the real Host and one quota line per account', async () => {
  await readableQuotaAccount()
  const out = system(['workers'])
  assert.equal(out.status, 0, out.stderr)
  assert.doesNotMatch(out.stdout, /fake-token|SECRET-ACCESS|SECRET-REFRESH/)
  assert.match(out.stdout, /quota: 5h 17%, read /)
  const blocks = out.stdout.trimEnd().split(/\n(?=\S)/).slice(1)
  assert.equal(blocks.length, 2)
  for (const block of blocks) assert.equal(block.match(/^  quota:/gm)?.length ?? 0, 1)
  assert.match(out.stdout, /quota: unreadable - a web account has no quota reader/)
})

test('quota readings survive a Host restart', async () => {
  const fake = fakeQuotaCli(join(home, 'restart-quota-cli'), { kind: 'claude', version: '2.1.322', answer: { rate_limits_available: false, rate_limits: {} } })
  const command = join(home, 'restart-claude')
  // Usage reads use the line-protocol peer; attempts use the existing fake agent.
  writeFileSync(command, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--input-format" ] || [ "$arg" = "--version" ]; then
    exec '${fake.command}' "$@"
  fi
done
exec '${fakeAgent}' "$@"
`)
  chmodSync(command, 0o700)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents
  config:
    $patch: replace
    accounts:
      - {ref: claude-code/restart, runtime: claude-code, capabilities: [research], command: ${JSON.stringify(command)}, tokenRef: CLAUDE_CODE_OAUTH_TOKEN}
`)
  await cli.start()
  const ran = system(['work', 'submit', '--capability', 'research', '--input', newTask('FAKE:outputs FAKE:ratelimit=seven_day:0.77')])
  assert.equal(ran.status, 0, ran.stderr)
  const before = system(['workers'])
  assert.equal(before.status, 0, before.stderr)
  assert.match(before.stdout, /quota: 7d 77%.*from the last attempt/)
  await cli.start()
  const restarted = system(['workers'])
  assert.equal(restarted.status, 0, restarted.stderr)
  assert.match(restarted.stdout, /quota: 7d 77%.*from the last attempt/)
})
