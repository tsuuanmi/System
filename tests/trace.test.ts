/**
 * Item trace-1: `system work trace <workId>` (and `--json`) and the MCP `work.trace`
 * tool on a Work with one failed check and one repair, built with the fake agent.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { fakeAgent, repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-trace')
const home = cli.home
const system = (args: string[]) => cli.runAsync(args).done

function gitRepo(checks: string): string {
  const dir = mkdtempSync(join(home, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(dir, 'README.md'), 'base\n')
  writeFileSync(join(dir, 'NOTE.md'), 'base\n')
  mkdirSync(join(dir, '.system'))
  writeFileSync(join(dir, '.system', 'checks.yaml'), checks)
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  return dir
}

const SE = join(home, 'software-engineering-checks.yaml')

before(async () => {
  assert.equal((await system(['init'])).status, 0)
  writeFileSync(SE, readFileSync(join(repo, 'workflows', 'develop.yaml'), 'utf8')
    .replace(/  - id: publish[\s\S]*?(?=  - id: accept)/, '')
    .replace('dependsOn: [publish]', 'dependsOn: [checks]')
    .replace('checks.checks, publish', 'checks.checks'))
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: runtime-cli
  config:
    $patch: replace
    accounts:
      - ref: claude-code/default
        runtime: claude-code
        capabilities: [repo.write, develop.implement, tier.standard]
        command: ${fakeAgent}
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN
        models: { standard: sonnet }
        maxConcurrentAttempts: 4
`)
  await cli.start()
  const set = cli.run(['credentials', 'set', 'CLAUDE_CODE_OAUTH_TOKEN'], { input: 'fake\n', terminal: true })
  assert.equal(set.status, 0, set.stderr)
  await cli.start()
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

test('trace-1: system work trace and work.trace show a Work with one failed check and one repair in order', { timeout: 120_000 }, async () => {
  // The base NOTE.md has one line and passes `two-edits`; the first attempt makes it two lines and fails; the automatic reopen's attempt makes three and passes.
  const repository = gitRepo('checks:\n  - name: two-edits\n    run: test "$(wc -l < NOTE.md)" -ne 2 || (echo "need two edits" >&2; exit 1)\n')
  const taskId = (await system(['task', 'new', '--text', 'FAKE:edit FAKE:append FAKE:turns', '--repo', repository])).stdout.trim().split('\n').at(-1)!
  const ran = await system(['work', 'submit', '--workflow', SE, '--input', taskId])
  assert.equal(ran.status, 0, ran.stdout + ran.stderr)
  const workId = ran.stdout.trim()

  const traced = await system(['work', 'trace', workId])
  assert.equal(traced.status, 0, traced.stderr)
  assert.match(traced.stdout, /claude-code\/default/)
  assert.match(traced.stdout, /two-edits/)
  assert.match(traced.stdout, /need two edits/)
  assert.match(traced.stdout, /reopened implement/)
  assert.match(traced.stdout, /outcome: succeeded/)

  const jsonRes = await system(['work', 'trace', workId, '--json'])
  assert.equal(jsonRes.status, 0, jsonRes.stderr)
  const data = JSON.parse(jsonRes.stdout) as { id: string; status: string; timeline: Array<{ kind: string; stepId?: string; account?: string; verdict?: string; failedChecks?: Array<{ name: string; stderrTail: string }>; previous?: string; failure?: string }> }
  assert.equal(data.id, workId)
  assert.equal(data.status, 'succeeded')
  assert.deepEqual(data.timeline.map((e) => e.kind), ['attempt', 'skipped', 'verdict', 'reopened', 'attempt', 'skipped', 'verdict', 'terminal'])
  assert.equal(data.timeline[0]!.account, 'claude-code/default')
  assert.equal(data.timeline[2]!.verdict, 'fail')
  assert.equal(data.timeline[2]!.failedChecks![0]!.name, 'two-edits')
  assert.match(data.timeline[2]!.failedChecks![0]!.stderrTail, /need two edits/)
  assert.ok(data.timeline[3]!.previous)
  assert.ok(data.timeline[3]!.failure)
  assert.equal(data.timeline[6]!.verdict, 'pass')

  // Caller operation `work.trace` through `system mcp`
  const client = new Client({ name: 'trace-test', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, 'bin', 'system'), 'mcp'], env: { ...process.env, DSH_HOME: home } })
  await client.connect(transport)
  try {
    const res = await client.callTool({ name: 'work.trace', arguments: { workId } }) as { isError?: boolean; content: { text: string }[] }
    assert.notEqual(res.isError, true, res.content[0]!.text)
    assert.deepEqual(JSON.parse(res.content[0]!.text), data)
  } finally {
    await client.close()
  }
})
