/**
 * ss-8: the scheduled session's sequence (tools/night-session.md) against a real Host with fake Workers:
 * claim, task_new, work_submit (which runs the Work and returns at once), `system work wait` in Bash
 * (exit 4 until the Work ends), work_report, for one Item. The tools are called as the
 * prompt names them and must be in the service script's allowlist.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-night', { SYSTEM_OPERATOR_ID: 'night' })
const home = cli.home
const hold = join(home, 'hold')
const prompt = readFileSync(join(repo, 'tools', 'night-session.md'), 'utf8')
const script = readFileSync(join(repo, 'packages', 'bundle', 'system-night-session.sh'), 'utf8')
const client = new Client({ name: 'night', version: '0' })

before(async () => {
  const init = cli.run(['init'])
  assert.equal(init.status, 0, init.stderr)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: verifiers
  disabled: true
- id: effects
  disabled: true
- id: fakes
  disabled: false
  config:
    workers: [code-write, code.develop, tier.standard]
    verifiers: [code.required-checks]
    effects: [git.publish]
`)
  await cli.start({ env: { SYSTEM_FAKE_HOLD_AT: 'implement', SYSTEM_FAKE_HOLD_FILE: hold } })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'bin', 'system'), 'mcp'], env: cli.env as Record<string, string> }))
})

after(async () => {
  await client.close()
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

/** A tool as the session calls it (`mcp__system__item_claim`); it must be named in the prompt and allowed by the script. */
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const shown = `mcp__system__${name}`
  assert.ok(prompt.includes(shown), `the prompt names ${shown}`)
  assert.ok(script.includes(shown), `the allowlist has ${shown}`)
  const result = await client.callTool({ name: name.replace('_', '.'), arguments: args })
  const text = (result.content as { text: string }[])[0]!.text
  assert.notEqual(result.isError, true, `${name}: ${text}`)
  return JSON.parse(text)
}

test('one Item: claim, task_new, work_submit, work wait (4 then 0), work_report', { timeout: 240_000 }, async () => {
  const project = realpathSync(mkdtempSync(join(home, 'project-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'dev')
  writeFileSync(join(project, 'STATUS.md'), 'Aim: a project\n- [ ] n-1 Do the thing with `backticks` and $HOME\n')
  git('add', '.'); git('commit', '-qm', 'status')

  const todo = await tool('status', { repository: project, state: 'todo' })
  assert.match(todo[0], /^\[ \] n-1 Do the thing/)
  assert.equal((await tool('item_claim', { repository: project, item: 'n-1' })).who, 'night')
  // The Task text goes as a tool argument: backticks and $ arrive as they are.
  const instructions = 'Carry out Item n-1 of STATUS.md: Do the thing with `backticks` and $HOME'
  const { task } = await tool('task_new', { instructions, repository: project, ref: 'dev', item: 'n-1' })
  assert.match(task, /^sha256:/)
  const shown = await tool('artifact_show', { id: task })
  assert.ok(JSON.stringify(shown).includes(task))

  // work_submit runs the Work and returns its record at once; the Worker is held, so the Work is still running.
  const submitted = await tool('work_submit', { workflow: join(repo, 'workflows', 'develop.yaml'), input: task })
  const work = submitted.id as string
  assert.match(work, /^work/)
  assert.match((await tool('status', { repository: project, item: 'n-1' }))[0], new RegExp(`doing: ${work}`))
  const early = cli.run(['work', 'wait', work, '--timeout', '0.02'])
  assert.equal(early.status, 4, early.stderr)

  writeFileSync(hold, '')
  let code = 4
  for (let i = 0; i < 4 && code === 4; i += 1) {
    const waited = cli.run(['work', 'wait', work, '--timeout', '1.5'])
    code = waited.status ?? -1
    if (code === 0) assert.match(waited.stdout, new RegExp(`^${work}  succeeded`))
  }
  assert.equal(code, 0)

  const shownWork = await tool('work_show', { workId: work })
  assert.equal(shownWork.state.status, 'succeeded')
  const report = await tool('work_report', { workId: work })
  assert.ok(report && typeof report === 'object')
  assert.ok((await tool('work_list', {})).some((w: { id: string }) => w.id === work))
})
