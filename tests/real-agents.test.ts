/**
 * Credential-gated: runs the real Claude Code and Codex accounts of the
 * operator's own `system` profile ($DSH_HOME or ~/.dsh) on a throwaway git
 * repository. Skipped unless SYSTEM_REAL_AGENTS=1. Uses subscription quota, at
 * the economy tier only.
 *
 *   SYSTEM_REAL_AGENTS=1 node --test tests/real-agents.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { repo, systemCli } from '../test-support/cli.ts'

const enabled = process.env.SYSTEM_REAL_AGENTS === '1'
/** The operator's own profile: real accounts and tokens. */
const cli = systemCli('system-real', { SYSTEM_CALLER: 'human' }, process.env.DSH_HOME || join(homedir(), '.dsh'))
const { env } = cli
const gitRepo = mkdtempSync(join(tmpdir(), 'system-real-'))

const system = (args: string[]) => cli.run(args, { timeoutMs: 900_000 })

type Observed = { type: string; attemptId?: string; status?: string; usage?: { state: string; inputTokens?: number }; worker?: { ref: string; version?: string; tier?: string; model?: string } }
const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as { events: Observed[]; state: { status: string; reason?: string; steps: { task: { outputs: { result?: string }; partial?: { result?: string } } } } }
const tree = (id: string) => (JSON.parse(system(['artifact', 'show', id]).stdout) as { envelope: { content: { commit: string; parent: string } } }).envelope.content
const fileAt = (commit: string, path: string) => execFileSync('git', ['-C', gitRepo, 'show', `${commit}:${path}`], { encoding: 'utf8' })

before(() => {
  if (!enabled) return
  const git = (...args: string[]) => execFileSync('git', ['-C', gitRepo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(gitRepo, 'README.md'), '# scratch repository for System real-agent tests\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  const workers = system(['workers'])
  assert.match(workers.stdout, /claude-code\/default\s+available/, workers.stdout)
  assert.match(workers.stdout, /codex\/default\s+available/, workers.stdout)
})

after(() => rmSync(gitRepo, { recursive: true, force: true }))

const newTask = (text: string) => system(['task', 'new', '--text', text, '--repo', gitRepo]).stdout.trim().split('\n').at(-1)!

test('Claude Code makes a real change, captured as an exact commit with observed usage', { skip: !enabled && 'set SYSTEM_REAL_AGENTS=1' }, () => {
  const ran = system(['work', 'submit', '--capability', 'code-write', 'tier.economy', '--input', newTask('Create a file named HELLO.md whose only content is the line: hello from System. Change nothing else.')])
  assert.equal(ran.status, 0, ran.stderr + ran.stdout)
  const record = show(ran.stdout.trim())
  const result = tree(record.state.steps.task.outputs.result!)
  assert.match(fileAt(result.commit, 'HELLO.md'), /hello from System/)
  const observed = record.events.find((e) => e.type === 'observed')!
  assert.equal(observed.worker?.ref, 'claude-code/default')
  assert.deepEqual([observed.worker?.tier, observed.worker?.model], ['economy', 'haiku'])
  assert.equal(observed.usage?.state, 'observed')
  assert.ok((observed.usage?.inputTokens ?? 0) > 0)
})

test('a cancelled Claude Code attempt is taken over by Codex from its partial tree', { skip: !enabled && 'set SYSTEM_REAL_AGENTS=1', timeout: 900_000 }, async () => {
  const input = newTask([
    'Do these three things in order, using the shell for step 2:',
    '1. Create NOTES.md containing the line: step one',
    '2. Run exactly this shell command in the foreground and wait for it to finish (do not background it, do not skip it): sleep 90',
    '3. Append the line: step two  to NOTES.md',
    'If NOTES.md already contains "step one", skip steps 1 and 2.',
  ].join('\n'))
  const submit = spawn(process.execPath, [join(repo, 'bin', 'system'), 'work', 'submit', '--capability', 'code-write', 'tier.economy', '--input', input], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  submit.stdout.on('data', (d) => { out += d })
  submit.stderr.on('data', (d) => { err += d })
  const exited = new Promise<number | null>((r) => submit.on('close', r))
  while (!out.trim()) await new Promise((r) => setTimeout(r, 200))
  const workId = out.trim().split('\n')[0]!
  // Cancel 3 s after dispatch: an agent CLI takes longer than that just to start, so the attempt is
  // always mid-run, whatever the model does with its instructions.
  const started = Date.now()
  while (!show(workId).events.some((e) => e.type === 'dispatched') && Date.now() - started < 60_000) await new Promise((r) => setTimeout(r, 250))
  await new Promise((r) => setTimeout(r, 3_000))
  const cancel = system(['work', 'cancel', workId, '--reason', 'real takeover test', '--wait'])
  assert.equal(cancel.status, 0, `cancel: ${cancel.stdout}${cancel.stderr}\nhost stderr: ${err}`)
  assert.equal(await exited, 5)
  const cancelled = show(workId)
  assert.equal(cancelled.state.status, 'cancelled')
  const partial = tree(cancelled.state.steps.task.partial!.result!)

  const retried = system(['work', 'retry', workId, '--worker', 'codex/default', '--reason', 'real takeover test'])
  assert.equal(retried.status, 0, retried.stderr + retried.stdout)
  const done = show(workId)
  const final = tree(done.state.steps.task.outputs.result!)
  assert.equal(final.parent, partial.commit, 'Codex started from the cancelled attempt\'s tree')
  assert.match(fileAt(final.commit, 'NOTES.md'), /step one/)
  const observed = done.events.filter((e) => e.type === 'observed')
  assert.deepEqual(observed.map((e) => [e.worker?.ref, e.status]), [['claude-code/default', 'cancelled'], ['codex/default', 'succeeded']])
  assert.equal(observed[1]!.usage?.state, 'observed')
  assert.deepEqual([observed[1]!.worker?.tier, observed[1]!.worker?.model], ['economy', 'gpt-6-luna'])
  assert.equal(system(['work', 'replay', workId]).status, 0)
})
