/** mcp-2: a `system mcp` started on one release serves its next calls with the client of the release `current` points to after an update. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { codeVersionAt } from '../packages/host/src/index.ts'
import { repo, systemCli } from '../test-support/cli.ts'

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

test('after the install moves to a second release and the Host restarts, status and work.submit succeed at the first call, served by the new release client', { timeout: 240_000 }, async () => {
  const base = realpathSync(mkdtempSync('/tmp/sm-front-'))
  const home = join(base, 'home')
  const current = join(base, 'current')
  const cli = systemCli('mcp-front', { HOME: home, SYSTEM_OPERATOR_ID: 'tester', SYSTEM_NO_SERVICE: '1' }, join(home, '.dsh'), join(current, 'bin', 'system'))
  delete cli.env.SYSTEM_CODE
  const client = new Client({ name: 'front-smoke', version: '0' })
  const move = (n: number) => {
    symlinkSync(`releases/r${n}`, join(base, 'current.tmp'))
    renameSync(join(base, 'current.tmp'), current)
  }
  const tool = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result = await client.callTool({ name, arguments: args })
    const text = (result.content as { text: string }[])[0]!.text
    assert.notEqual(result.isError, true, `${name}: ${text}`)
    return JSON.parse(text)
  }
  try {
    mkdirSync(join(base, 'releases'), { recursive: true })
    for (const n of [1, 2]) {
      const release = join(base, 'releases', `r${n}`)
      mkdirSync(release)
      execFileSync('cp', ['-a', '--reflink=auto', ...['bin', 'packages', 'node_modules', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'patches', 'workflows'].map((name) => join(repo, name)), release], { timeout: 60_000 })
      if (n > 1) {
        const file = join(release, 'packages', 'app', 'lib', 'client.js')
        const original = readFileSync(file, 'utf8')
        rmSync(file)
        writeFileSync(file, `${original}\n// r${n}\n`)
      }
    }
    const [v1, v2] = [1, 2].map((n) => codeVersionAt(join(base, 'releases', `r${n}`)))
    assert.notEqual(v1, v2)
    move(1)
    assert.equal(cli.run(['init']).status, 0)
    writeFileSync(join(home, '.dsh', 'profiles', 'system', 'cordis.patch.yml'), FAKES)
    let host = await cli.start()
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(current, 'bin', 'system'), 'mcp'], env: cli.env as Record<string, string>, stderr: 'pipe' })
    let log = ''
    transport.stderr!.on('data', (data) => { log += data })
    await client.connect(transport)

    const project = mkdtempSync(join(base, 'project-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
    git('init', '-q', '-b', 'dev')
    writeFileSync(join(project, 'STATUS.md'), 'Aim: a project\n- [ ] n-1 Do the thing\n')
    git('add', '.'); git('commit', '-qm', 'status')

    await tool('status', { repository: project, state: 'todo' })
    assert.match(log, new RegExp(`client code ${v1}`))
    const { task } = await tool('task.new', { instructions: 'Carry out Item n-1', repository: project, ref: 'dev', item: 'n-1' })

    move(2)
    assert.deepEqual(await host.exited, { code: 75, signal: null }, host.stderr())
    host = await cli.start()
    await tool('status', { repository: project, state: 'todo' })
    assert.match(log, new RegExp(`client code ${v2}`), `the new release's client serves the session: ${log}`)
    const submitted = await tool('work.submit', { workflow: join(repo, 'workflows', 'develop.yaml'), input: task })
    assert.match(submitted.id, /^work/)
  } finally {
    await client.close()
    await cli.stop()
    rmSync(base, { recursive: true, force: true })
  }
})
