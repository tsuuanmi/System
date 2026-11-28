/**
 * WW2a: System without the web Runtime. The `runtime-web` row is off (the bundle's
 * default) and the profile still runs its main path on the fake Runtimes: a
 * Software Engineering Work and a Brainstorm. With the row off there are no `web`
 * Accounts (ADR-0018 decision 3: disabling a Runtime's row removes its Accounts); nothing of the web package is loaded.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-web-off')
const { home } = cli
const system = (args: string[], input?: string) => cli.run(args, { input })

const yaml = createRequire(join(repo, 'packages', 'work', 'package.json'))('yaml') as { parse(text: string, options: { logLevel: 'error' }): unknown }
const bundle = yaml.parse(readFileSync(join(repo, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as { insert: { id: string; disabled?: boolean; config?: { accounts?: object[] } }[] }[]
const row = (id: string) => bundle[0]!.insert.find((r) => r.id === id)!

/** The Software Engineering file without its publish step (tests/publish.test.ts covers the whole file). */
const SE = join(home, 'software-engineering-checks.yaml')
writeFileSync(SE, readFileSync(join(repo, 'workflows', 'develop.yaml'), 'utf8').replace(/  - id: publish[\s\S]*?(?=  - id: accept)/, '').replace('dependsOn: [publish]', 'dependsOn: [checks]').replace('checks.checks, publish', 'checks.checks'))
writeFileSync(join(home, 'code-checks.yaml'), readFileSync(join(repo, 'workflows', 'code-checks.yaml')))

before(async () => {
  assert.equal(system(['init']).status, 0)
  // The bundle's accounts on the fake CLI. No patch touches the runtime-web row.
  const accounts = row('runtime-cli').config!.accounts!.map((a) => ({ ...a, command: fakeAgent }))
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: runtime-cli\n  config: ${JSON.stringify({ accounts })}\n`)
  mkdirSync(join(home, 'system', 'codex', 'default'), { recursive: true })
  writeFileSync(join(home, 'system', 'codex', 'default', 'auth.json'), '{}')
  await cli.start()
  assert.equal(cli.run(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], { input: 'fake-token\n', terminal: true }).status, 0)
  await cli.start()
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

test('the runtime-web row is off in the bundle', () => {
  assert.equal(row('runtime-web').disabled, true)
})

test('system workers lists no web account while the row is off; the CLI accounts are available', () => {
  const out = system(['workers'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /registered: claude-code\/default, codex\/default\n/)
  assert.doesNotMatch(out.stdout, /web\//)
  assert.match(out.stdout, /claude-code\/default\s+available.*\(claude-code\)\n/, 'the runtime ends each account line: tools/web-canary reads it')
})

test('system workers shows each account\'s capabilities and the model of each tier (df-23), and no secret', () => {
  const out = system(['workers'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /claude-code\/default[^\n]*\(claude-code\)\n\s+abilities: repo\.read, repo\.write, web\.search\n\s+capabilities: develop\.implement, research,[^\n]*tier\.economy, tier\.standard, tier\.frontier\n\s+models: economy=haiku, standard=sonnet, frontier=opus\n/)
  assert.match(out.stdout, /codex\/default[^\n]*\(codex\)\n\s+abilities: repo\.read, repo\.write\n\s+capabilities: brainstorm\.idea-b, tier\.economy, tier\.standard, tier\.frontier\n\s+models: economy=gpt-6-luna, standard=gpt-6\.1-sol, frontier=gpt-6-astra\n/)
  assert.doesNotMatch(out.stdout, /CLAUDE_CODE_OAUTH_TOKEN|auth\.json/)
})

test('login, the remote viewer and recheck of a web ref are refused: no such Account', () => {
  writeFileSync(join(home, 'cookies.json'), '[]')
  for (const args of [['workers', 'login', 'web/chatgpt/default', '--cookies', join(home, 'cookies.json')], ['workers', 'login', 'web/chatgpt/default', '--remote'], ['workers', 'recheck', 'web/chatgpt/default']]) {
    // A human's commands: a pseudo-terminal, which merges stderr into stdout (ADR-0011).
    const ran = cli.run(args, { terminal: true })
    assert.equal(ran.status, 1)
    assert.match(ran.stdout, /web\/chatgpt\/default/)
  }
})

test('a Software Engineering Work runs on the fake Runtime', { timeout: 120_000 }, () => {
  const repository = mkdtempSync(join(home, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(repository, 'README.md'), 'base\n')
  mkdirSync(join(repository, '.system'))
  writeFileSync(join(repository, '.system', 'checks.yaml'), 'checks:\n  - name: note-exists\n    run: test -f NOTE.md\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  const task = system(['task', 'new', '--text', 'FAKE:edit', '--repo', repository])
  assert.equal(task.status, 0, task.stderr)
  const ran = system(['work', 'submit', '--workflow', SE, '--input', task.stdout.trim().split('\n').at(-1)!])
  assert.equal(ran.status, 0, ran.stderr)
  const record = JSON.parse(system(['work', 'show', ran.stdout.trim()]).stdout) as { state: { status: string } }
  assert.equal(record.state.status, 'succeeded')
})

test('a Brainstorm runs on the fake Runtimes', { timeout: 120_000 }, () => {
  const brief = system(['task', 'new', '--text', 'How should System schedule Work? FAKE:outputs FAKE:sign'])
  assert.equal(brief.status, 0, brief.stderr)
  const ran = system(['work', 'submit', '--workflow', join(repo, 'workflows', 'brainstorm.yaml'), '--input', brief.stdout.trim().split('\n').at(-1)!])
  assert.equal(ran.status, 0, ran.stderr)
  const record = JSON.parse(system(['work', 'show', ran.stdout.trim()]).stdout) as { state: { status: string } }
  assert.equal(record.state.status, 'succeeded')
})
