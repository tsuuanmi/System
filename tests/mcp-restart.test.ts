/** mcp-1: a long-lived `system mcp` outlives a Host restart: its next call reconnects and is sent again, with no error. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-mcprs', { SYSTEM_OPERATOR_ID: 'tester' })
const home = cli.home
const client = new Client({ name: 'restart', version: '0' })
const FAKES = `- id: verifiers
  disabled: true
- id: effects
  disabled: true
- id: fakes
  disabled: false
  config:
    workers: [repo.write, develop.implement, tier.standard]
    verifiers: [code.required-checks]
    effects: [git.publish]
`

before(async () => {
  assert.equal(cli.run(['init']).status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), FAKES)
  await cli.start()
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'bin', 'system'), 'mcp'], env: cli.env as Record<string, string> }))
})

after(async () => {
  await client.close()
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[])[0]!.text
  assert.notEqual(result.isError, true, `${name}: ${text}`)
  return JSON.parse(text)
}

test('status and work.submit succeed at the first call after a Host restart, and the submit makes one Work', { timeout: 240_000 }, async () => {
  const project = realpathSync(mkdtempSync(join(home, 'project-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'dev')
  writeFileSync(join(project, 'STATUS.md'), 'Aim: a project\n- [ ] n-1 Do the thing\n')
  git('add', '.'); git('commit', '-qm', 'status')

  await tool('status', { repository: project, state: 'todo' })
  const { task } = await tool('task.new', { instructions: 'Carry out Item n-1', repository: project, ref: 'dev', item: 'n-1' })

  // A plain restart (SIGTERM, then start again), not an update: the MCP's connection is dead.
  await cli.start()
  await tool('status', { repository: project, state: 'todo' })

  const before = (await tool('work.list', {})).length
  await cli.start()
  const submitted = await tool('work.submit', { workflow: join(repo, 'workflows', 'develop.yaml'), input: task })
  assert.match(submitted.id, /^work/)
  const list = await tool('work.list', {})
  assert.equal(list.length - before, 1)
})
