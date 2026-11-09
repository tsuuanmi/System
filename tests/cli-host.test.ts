/**
 * H4b: the CLI as a thin client of the Host. A real Host on a throwaway home
 * with the `fakes` row on; a Worker held in it by a file (SYSTEM_FAKE_HOLD_FILE)
 * keeps a Work running while the CLI that followed it goes away.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { systemCli, type Running } from '../test-support/cli.ts'

const cli = systemCli('system-cli-host')
const home = cli.home
const hold = join(home, 'hold')
const held = { SYSTEM_FAKE_HOLD_AT: 'task', SYSTEM_FAKE_HOLD_FILE: hold }
const system = (...args: string[]) => cli.run(args)
const status = (workId: string) => (JSON.parse(system('work', 'show', workId).stdout) as { state: { status: string } }).state.status

const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await ok()) return
  assert.fail(`timed out waiting for ${what}`)
}

/** The Work ID a following command printed first, once the Worker holds the attempt. */
async function admitted(run: Running): Promise<string> {
  await until('the Work ID', () => run.stdout().includes('\n'))
  const workId = run.stdout().split('\n')[0]!
  await until('the Worker to hold', () => (JSON.parse(system('work', 'show', workId).stdout) as { events: { type: string }[] }).events.some((e) => e.type === 'dispatched'))
  return workId
}

before(async () => {
  assert.equal(system('init').status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: verifiers
  disabled: true
- id: effects
  disabled: true
- id: fakes
  disabled: false
  config:
    workers: [code-write]
`)
  await cli.start({ env: held })
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

test('with no Host, a command prints one line and exits 1', () => {
  const empty = systemCli('system-no-host')
  try {
    const ran = empty.run(['work', 'list'])
    assert.equal(ran.status, 1)
    assert.equal(ran.stdout, '')
    assert.equal(ran.stderr, `system: the System Host is not running for ${empty.home}: systemctl --user start system (or run: system host)\n`)
  } finally {
    rmSync(empty.home, { recursive: true, force: true })
  }
})

test('doctor boots DSH and reports that the Host answers', () => {
  const ran = system('doctor', '--json')
  assert.equal(ran.status, 0, ran.stderr)
  const { host } = JSON.parse(ran.stdout) as { host: { answering: boolean; detail: string } }
  assert.equal(host.answering, true)
  assert.match(host.detail, /^version \S+, pid \d+$/)
  assert.match(system('doctor').stdout, /host\s+answering: version /)
})

test('an error is one line; SYSTEM_DEBUG=1 adds the stack', () => {
  const ran = system('work', 'show', 'work:nope')
  assert.equal(ran.status, 1)
  assert.equal(ran.stderr, 'system: no Work work:nope\n')
  const debug = cli.run(['work', 'show', 'work:nope'], { env: { SYSTEM_DEBUG: '1' } })
  assert.match(debug.stderr, /^system: .*no Work work:nope\n\s+at /)
})

test('Ctrl-C detaches: exit 0, and the Work finishes in the Host', { timeout: 120_000 }, async () => {
  rmSync(hold, { force: true })
  const run = cli.runAsync(['work', 'submit', '--capability', 'code-write'])
  const workId = await admitted(run)
  assert.equal(status(workId), 'running')
  run.child.kill('SIGINT')
  const ran = await run.done
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stderr, new RegExp(`detached; ${workId} goes on in the Host`))
  assert.equal(status(workId), 'running', 'the Host still runs it')
  writeFileSync(hold, '')
  await until('the Work to finish', () => status(workId) === 'succeeded')
})

test('--cancel-on-interrupt cancels the Work at Ctrl-C and follows it to the end: exit 5', { timeout: 120_000 }, async () => {
  rmSync(hold, { force: true })
  const run = cli.runAsync(['work', 'submit', '--capability', 'code-write', '--cancel-on-interrupt'])
  const workId = await admitted(run)
  run.child.kill('SIGINT')
  const ran = await run.done
  assert.equal(ran.status, 5, ran.stderr)
  assert.equal(status(workId), 'cancelled')
})

test('a timeout retries once with the same commandId: one Work', { timeout: 120_000 }, async () => {
  const proxyHome = join(home, 'proxy')
  mkdirSync(join(proxyHome, 'system'), { recursive: true })
  const seen: string[] = []
  let dropped = false
  const proxy = createServer((client) => {
    const host = createConnection(cli.socket)
    let upstream = ''
    let downstream = ''
    let lost: number | undefined
    client.on('data', (chunk) => {
      upstream += chunk
      for (let at = upstream.indexOf('\n'); at >= 0; at = upstream.indexOf('\n')) {
        const request = JSON.parse(upstream.slice(0, at)) as { id: number; method: string; params?: { commandId?: string } }
        upstream = upstream.slice(at + 1)
        if (request.method === 'work.submit') {
          seen.push(request.params!.commandId!)
          // The first submit reaches the Host, but its answer never comes back.
          if (!dropped) { dropped = true; lost = request.id }
        }
        host.write(`${JSON.stringify(request)}\n`)
      }
    })
    host.on('data', (chunk) => {
      downstream += chunk
      for (let at = downstream.indexOf('\n'); at >= 0; at = downstream.indexOf('\n')) {
        const line = downstream.slice(0, at)
        downstream = downstream.slice(at + 1)
        if ((JSON.parse(line) as { id: number }).id !== lost) client.write(`${line}\n`)
      }
    })
    client.on('close', () => host.destroy())
    client.on('error', () => host.destroy())
    host.on('error', () => client.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(join(proxyHome, 'system', 'host.sock'), resolve))
  try {
    const before = system('work', 'list').stdout.split('\n').filter(Boolean).length
    // Asynchronously: the proxy lives in this process.
    const ran = await cli.runAsync(['work', 'submit', '--capability', 'code-write', '--no-run'], { env: { DSH_HOME: proxyHome } }).done
    assert.equal(ran.status, 0, ran.stderr)
    assert.match(ran.stdout, /^work:[0-9a-f-]+\n$/)
    assert.equal(seen.length, 2)
    assert.equal(seen[0], seen[1], 'the retry reuses the commandId')
    assert.equal(system('work', 'list').stdout.split('\n').filter(Boolean).length, before + 1, 'one Work was admitted')
  } finally {
    proxy.close()
  }
})

test('a Host that does not answer is named, with the runbook', { timeout: 60_000 }, async () => {
  const silentHome = join(home, 'silent')
  mkdirSync(join(silentHome, 'system'), { recursive: true })
  const sockets: Socket[] = []
  const silent = createServer((socket) => { sockets.push(socket) })
  await new Promise<void>((resolve) => silent.listen(join(silentHome, 'system', 'host.sock'), resolve))
  try {
    const ran = cli.run(['work', 'list'], { env: { DSH_HOME: silentHome } })
    assert.equal(ran.status, 1)
    assert.match(ran.stderr, /^system: the System Host for \S+ is not answering .*docs\/operations\/runbook\.md.*\n$/)
  } finally {
    for (const socket of sockets) socket.destroy()
    silent.close()
  }
})

test('status shows an Item as todo, then doing while its Work runs; a second Work is refused unless forced', { timeout: 120_000 }, async () => {
  const project = realpathSync(mkdtempSync(join(home, 'project-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'dev')
  writeFileSync(join(project, 'STATUS.md'), 'Aim: a project\n- [x] p-1 First\n- [ ] p-2 Second\n')
  git('add', '.')
  git('commit', '-qm', 'status')
  assert.equal(system('status', '--repo', project).stdout, '[x] p-1 First - done\n[ ] p-2 Second - todo: nobody\n')
  assert.match(system('status', '--repo', project, '--state', 'bogus').stderr, /--state is todo, doing or done/)
  const task = system('task', 'new', '--text', 'do p-2', '--repo', project, '--ref', 'dev', '--item', 'p-2').stdout.trim().split('\n').at(-1)!
  rmSync(hold, { force: true })
  const run = cli.runAsync(['work', 'submit', '--capability', 'code-write', '--input', task])
  const workId = await admitted(run)
  const line = system('status', '--repo', project, '--item', 'p-2').stdout
  assert.match(line, new RegExp(`^\\[ \\] p-2 Second - doing: ${workId} step task on fake/\\S+ since \\S+Z`))
  assert.equal(system('status', '--repo', project, '--state', 'doing').stdout, line)
  const refused = system('work', 'submit', '--capability', 'code-write', '--input', task, '--no-run')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, new RegExp(`^system: Item p-2 already has Work ${workId} \\(running, fake/\\S+\\)`))
  const forced = system('work', 'submit', '--capability', 'code-write', '--input', task, '--no-run', '--force')
  assert.equal(forced.status, 0, forced.stderr)
  run.child.kill('SIGINT')
  await run.done
  writeFileSync(hold, '')
  await until('the Work to finish', () => status(workId) === 'succeeded')
})
