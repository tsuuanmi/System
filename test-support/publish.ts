/** Shared by tests/publish*.test.ts: a booted profile, a bare remote, the fake GitHub, and the Host the tests kill and start again. */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before } from 'node:test'
import { fakeAgent, repo, systemCli } from './cli.ts'

export const mainOf = (bare: string) => execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim()

export type Event = { type: string; state?: string; reason?: string; detail?: Record<string, string>; subject?: string }

export function publishHarness(prefix: string) {
  const cli = systemCli(prefix)
  const { home, env } = cli
  /** The process ID of the running Host, for a fake remote or a hook to kill. */
  const hostPid = join(home, 'host.pid')
  const SE_MERGE = join(repo, 'workflows', 'develop.yaml')
  /** The Software Engineering Workflow publishing a draft pull request: its `merge: true` removed. */
  const SE = join(home, 'software-engineering-draft.yaml')
  const servers: ChildProcess[] = []


  const system = (args: string[]) => cli.run(args)

  /** Start the Host again, for a profile written since it started; its process ID is where the killers look. */
  async function restart() {
    await cli.start()
    writeFileSync(hostPid, String(await cli.pid()))
  }

  async function github(...args: string[]): Promise<{ url: string; state: () => Promise<{ pulls: { number: number; head: string; draft: boolean; merged?: boolean; mergeCommit?: string }[]; calls: string[] }> }> {
    const server = spawn(process.execPath, [join(repo, 'tests', 'fake-github.mjs'), ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
    servers.push(server)
    const port = await new Promise<string>((r) => server.stdout!.once('data', (d) => r(String(d).trim())))
    const url = `http://127.0.0.1:${port}`
    return { url, state: async () => (await fetch(`${url}/_state`)).json() as never }
  }

  function profile(apiUrl: string, mergeInto = '[]') {
    writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents
  config:
    $patch: replace
    accounts:
      - ref: claude-code/default
        runtime: claude-code
        capabilities: [code-write, code.develop, tier.standard]
        command: ${fakeAgent}
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN
- id: effects
  config:
    remote: origin
    base: main
    mergeInto: ${mergeInto}
    apiUrl: ${apiUrl}
    repository: tester/scratch
    tokenRef: GITHUB_TOKEN
`)
  }

  /** A repository with required checks, its bare `origin`, and a task on it. */
  function project() {
    const bare = mkdtempSync(join(home, 'remote-'))
    execFileSync('git', ['init', '--bare', '--quiet', bare])
    const work = mkdtempSync(join(home, 'repo-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', work, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf8' }).trim()
    git('init', '--quiet', '-b', 'main')
    mkdirSync(join(work, '.system'))
    writeFileSync(join(work, '.system', 'checks.yaml'), 'checks:\n  - name: note-exists\n    run: test -f NOTE.md\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'base')
    git('remote', 'add', 'origin', `file://${bare}`)
    git('push', '--quiet', 'origin', 'main')
    const task = system(['task', 'new', '--text', 'FAKE:edit', '--repo', work]).stdout.trim().split('\n').at(-1)!
    return { bare, work, task, branchOf: (workId: string) => execFileSync('git', ['-C', bare, 'rev-parse', `refs/heads/system/${workId.replace('work:', '')}`], { encoding: 'utf8' }).trim() }
  }

  const show = (workId: string) => JSON.parse(system(['work', 'show', workId]).stdout) as { events: Event[]; state: { status: string; reason?: string; steps: Record<string, { outputs: Record<string, string> }> } }
  /** What the Host's start leaves of a Work it was killed in: the effect was intended, and its outcome has been read from the remote, but nothing runs on until `work run`. */
  function assertRecovered(workId: string) {
    const record = show(workId)
    assert.ok(record.events.some((e) => e.type === 'effect-intended'))
    assert.equal(record.state.status, 'running')
    assert.notEqual(record.events.at(-1)?.type, 'terminal')
  }
  const commitOf = (artifactId: string) => (JSON.parse(system(['artifact', 'show', artifactId]).stdout) as { envelope: { content: { commit: string } } }).envelope.content.commit

  before(async () => {
    assert.equal(system(['init']).status, 0)
    await restart()
    const merging = readFileSync(SE_MERGE, 'utf8')
    assert.ok(merging.includes('      params: { merge: true }\n'))
    writeFileSync(SE, merging.replace('      params: { merge: true }\n', ''))
    copyFileSync(join(repo, 'workflows', 'code-checks.yaml'), join(home, 'code-checks.yaml'))
    for (const [name, value] of [['CLAUDE_CODE_OAUTH_TOKEN', 'fake'], ['GITHUB_TOKEN', 'ghs_test']]) {
      assert.equal(cli.run(['credentials', 'set', name!], { input: `${value}\n`, terminal: true }).status, 0)
    }
  })

  after(async () => {
    await cli.stop()
    for (const s of servers) s.kill()
    rmSync(home, { recursive: true, force: true })
  })

  return { cli, home, env, hostPid, SE, SE_MERGE, system, restart, github, profile, project, show, assertRecovered, commitOf }
}

