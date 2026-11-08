/**
 * The web Runtime (Site chatgpt) through the real Host and `bin/system`, against the
 * local fake ChatGPT site of packages/web-driver/tests/fake-chatgpt.ts: login by
 * cookie file, then a Work whose answer fills the output slot and is stored as
 * a conversation. No network and no account. A headed Chrome that cannot start fails it (test-support/headed.ts).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { repo, systemCli } from '../test-support/cli.ts'
import { CHROME, skipHeaded } from '../test-support/headed.ts'
import { findVnc } from '../packages/web-worker/src/display.ts'

const skip = skipHeaded
const serve = join(repo, 'packages', 'web-driver', 'tests', 'serve-fake-chatgpt.ts')
const cli = systemCli('system-web')
const { home } = cli
const system = (args: string[], input?: string) => cli.run(args, { input })
/** The fake sites run in their own processes: the CLI runner blocks this one while it waits. */
const servers: ChildProcess[] = []
/** A fake site with these options; its origin. */
async function site(options: object): Promise<string> {
  const server = spawn(process.execPath, [serve, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'inherit'] })
  servers.push(server)
  return new Promise<string>((resolve) => server.stdout!.once('data', (d) => resolve(String(d).trim())))
}

before(async () => {
  if (skip) return
  const answer = '```result\ncontent of result\nsecond line\n```'
  const signedIn = await site({ answer })
  const signedOut = await site({ answer, signedIn: false })
  assert.equal(system(['init']).status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: web-worker
  disabled: false
- id: agents
  config:
    accounts:
      - ref: web/chatgpt/default
        runtime: web
        site: chatgpt
        capabilities: [research]
        url: ${signedIn}/
        executablePath: ${CHROME}
        timeouts: {load: 20, answer: 30, stable: 0.5}
      - ref: web/chatgpt/anon
        runtime: web
        site: chatgpt
        capabilities: [web-search]
        url: ${signedOut}/
        executablePath: ${CHROME}
        timeouts: {load: 5, answer: 5, stable: 0.5}
`)
  await cli.start()
})

after(async () => {
  await cli.stop()
  for (const server of servers) server.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
})

const cookies = (dir: string) => {
  const file = join(dir, 'cookies.json')
  writeFileSync(file, JSON.stringify([{ name: 'session', value: 'SECRET-COOKIE-VALUE', domain: '.chatgpt.com', path: '/', secure: true }]))
  return file
}

test('login imports a cookie file, reports the signed-in state and prints no cookie value', { skip, timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(home, 'cookies-'))
  const ran = system(['workers', 'login', 'web/chatgpt/default', '--cookies', cookies(dir)])
  assert.equal(ran.status, 0, ran.stderr + ran.stdout)
  assert.match(ran.stdout, /imported 1 cookie\(s\)/)
  assert.match(ran.stdout, /web\/chatgpt\/default: signed in/)
  assert.doesNotMatch(ran.stdout + ran.stderr, /SECRET-COOKIE-VALUE/)
  assert.ok(existsSync(join(dir, 'cookies.json')), 'the operator\'s file is left alone')
})

test('login says so when the page still shows a sign-in wall, and refuses a manual sign-in without a display', { skip, timeout: 120_000 }, () => {
  const walled = system(['workers', 'login', 'web/chatgpt/anon', '--cookies', cookies(mkdtempSync(join(home, 'cookies-')))])
  assert.equal(walled.status, 1)
  assert.match(walled.stdout, /not signed in: .*sign-in wall/)
  const manual = cli.run(['workers', 'login', 'web/chatgpt/default'], { env: { DISPLAY: '' } })
  assert.equal(manual.status, 1)
  assert.match(manual.stderr, /no display.*--cookies/)
  assert.equal(system(['workers', 'login', 'codex/default']).status, 1)
})

test('a Work runs on the account: the answer fills the slot and the exchange is a conversation', { skip, timeout: 120_000 }, () => {
  const task = system(['task', 'new', '--text', 'Say something about the fake topic.']).stdout.trim().split('\n').at(-1)!
  const ran = system(['work', 'submit', '--capability', 'research', '--input', task])
  assert.equal(ran.status, 0, ran.stderr + ran.stdout)
  const record = JSON.parse(system(['work', 'show', ran.stdout.trim()]).stdout) as { state: { status: string; steps: { task: { outputs: { result: string } } } }; events: { type: string; worker?: { ref: string } }[] }
  assert.equal(record.state.status, 'succeeded')
  assert.equal(record.events.find((e) => e.type === 'observed')?.worker?.ref, 'web/chatgpt/default')
  assert.equal(system(['artifact', 'cat', record.state.steps.task.outputs.result]).stdout, 'content of result\nsecond line')
  const workers = system(['workers'])
  assert.match(workers.stdout, /web\/chatgpt\/default\s+available/)
})

test('recheck passes on the signed-in account; on the walled one it fails and `system workers` shows the quarantine and what to do', { skip, timeout: 120_000 }, () => {
  const passed = system(['workers', 'recheck', 'web/chatgpt/default'])
  assert.equal(passed.status, 0, passed.stderr + passed.stdout)
  assert.match(passed.stdout, /web\/chatgpt\/default: ready: .*nothing was sent/)
  const failed = system(['workers', 'recheck', 'web/chatgpt/anon'])
  assert.equal(failed.status, 1)
  assert.match(failed.stdout, /web\/chatgpt\/anon: not ready \(needs-sign-in\)/)
  assert.match(system(['workers']).stdout, /web\/chatgpt\/anon\s+unavailable .*- needs sign-in since \d\d:\d\d: run `system workers login web\/chatgpt\/anon --remote`, then `system workers recheck web\/chatgpt\/anon`/)
  assert.match(system(['workers']).stdout, /web\/chatgpt\/default\s+available/)
})

// The remote login needs a VNC server (x11vnc or x0vncserver) as well.
const skipRemote = skip || (findVnc() ? false : 'neither x11vnc nor x0vncserver is on PATH (docs/operations/runbook.md)')
test('login --remote prints the tunnel and the address, serves noVNC behind the token, and Save reports the state', { skip: skipRemote, timeout: 120_000 }, async () => {
  const running = cli.runAsync(['workers', 'login', 'web/chatgpt/default', '--remote'])
  try {
    let url: string | undefined
    for (const end = Date.now() + 60_000; !url && Date.now() < end;) {
      url = /(http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}\/)/.exec(running.stdout())?.[1]
      if (!url) await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(url, running.stdout() + running.stderr())
    const port = /127\.0\.0\.1:(\d+)/.exec(url)![1]
    assert.match(running.stdout(), new RegExp(`ssh -L ${port}:127\\.0\\.0\\.1:${port} \\S+@\\S+`))
    assert.equal((await fetch(url.replace(/[A-Za-z0-9_-]{43}/, 'wrong'))).status, 404)
    assert.equal((await fetch(url)).status, 200)
    assert.equal((await fetch(`${url}save`, { method: 'POST', headers: { origin: new URL(url).origin } })).status, 200)
    const ended = await running.done
    assert.equal(ended.status, 0, ended.stderr + ended.stdout)
    assert.match(ended.stdout, /web\/chatgpt\/default: signed in/)
  } finally {
    running.child.kill('SIGKILL')
  }
})
