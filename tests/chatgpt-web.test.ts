/**
 * The chatgpt-web Runtime through the real Host and `bin/system`, against the
 * local fake ChatGPT page of packages/agents/tests/fake-chatgpt: login by
 * cookie file, then a Work whose answer fills the output slot and is stored as
 * a conversation. No network and no account. Skipped without Chrome.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { repo, systemCli } from '../test-support/cli.ts'

const CHROME = '/usr/bin/google-chrome'
const skip = !existsSync(CHROME) && `${CHROME} is not installed`
const pages = join(repo, 'packages', 'agents', 'tests', 'fake-chatgpt')
const cli = systemCli('system-web')
const { home } = cli
const system = (args: string[], input?: string) => cli.run(args, { input })
/** The fake page runs in its own process: the CLI runner blocks this one while it waits. */
let server: ChildProcess | undefined

before(async () => {
  if (skip) return
  server = spawn(process.execPath, [join(pages, 'serve.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<string>((resolve) => server!.stdout!.once('data', (d) => resolve(String(d).trim())))
  const base = `http://127.0.0.1:${port}/`
  assert.equal(system(['init']).status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: agents
  config:
    accounts:
      - ref: chatgpt-web/default
        runtime: chatgpt-web
        capabilities: [research]
        url: ${base}?slots=result
        timeouts: {load: 20, send: 20, answer: 30, stable: 0.5}
      - ref: chatgpt-web/anon
        runtime: chatgpt-web
        capabilities: [web-search]
        url: ${base}?scenario=signin
        timeouts: {load: 5, send: 5, answer: 5, stable: 0.5}
`)
  await cli.start()
})

after(async () => {
  await cli.stop()
  server?.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
})

const cookies = (dir: string) => {
  const file = join(dir, 'cookies.json')
  writeFileSync(file, JSON.stringify([{ name: 'session', value: 'SECRET-COOKIE-VALUE', domain: '.chatgpt.com', path: '/', secure: true }]))
  return file
}

test('login imports a cookie file, reports the signed-in state and prints no cookie value', { skip, timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(home, 'cookies-'))
  const ran = system(['workers', 'login', 'chatgpt-web/default', '--cookies', cookies(dir)])
  assert.equal(ran.status, 0, ran.stderr + ran.stdout)
  assert.match(ran.stdout, /imported 1 cookie\(s\)/)
  assert.match(ran.stdout, /chatgpt-web\/default: signed in/)
  assert.doesNotMatch(ran.stdout + ran.stderr, /SECRET-COOKIE-VALUE/)
  assert.ok(existsSync(join(dir, 'cookies.json')), 'the operator\'s file is left alone')
})

test('login says so when the page still shows a sign-in wall, and refuses a manual sign-in without a display', { skip, timeout: 120_000 }, () => {
  const walled = system(['workers', 'login', 'chatgpt-web/anon', '--cookies', cookies(mkdtempSync(join(home, 'cookies-')))])
  assert.equal(walled.status, 1)
  assert.match(walled.stdout, /not signed in: .*sign-in wall/)
  const manual = cli.run(['workers', 'login', 'chatgpt-web/default'], { env: { DISPLAY: '' } })
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
  assert.equal(record.events.find((e) => e.type === 'observed')?.worker?.ref, 'chatgpt-web/default')
  assert.equal(system(['artifact', 'cat', record.state.steps.task.outputs.result]).stdout, 'content of result\nsecond line')
  const workers = system(['workers'])
  assert.match(workers.stdout, /chatgpt-web\/default\s+available/)
})
