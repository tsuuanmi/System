/**
 * Smoke test for `system items carry <id> --repo <path>` (Item sch-1) through a real Host with the `fakes` row.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { systemCli } from '../test-support/cli.ts'
import { withFakes } from '../test-support/fakes.ts'

const cli = systemCli('system-items-carry', { SYSTEM_OPERATOR_ID: 'tester' })
const home = cli.home
const patch = join(home, 'profiles', 'system', 'cordis.patch.yml')
const log = join(home, 'fake-calls.log')
const FAKES_ON = withFakes({
  workers: ['repo.write', 'develop.implement', 'tier.standard'],
  verifiers: ['code.required-checks'],
  effects: ['git.publish'],
})

const system = (args: string[]) => cli.run(args)
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])

let project = ''

before(async () => {
  assert.equal(system(['init']).status, 0)
  writeFileSync(patch, FAKES_ON)
  await cli.start({ env: { SYSTEM_FAKE_LOG: log } })
  project = mkdtempSync(join(home, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    encoding: 'utf8',
  })
  git('init', '--quiet', '-b', 'dev')
  writeFileSync(join(project, 'STATUS.md'), '# Project\n\nAim: smoke test\n\n## Items\n\n- [ ] a-1 Ready item\n- [ ] a-2 Blocked item (after: a-1)\n')
  mkdirSync(join(project, 'workflows'), { recursive: true })
  git('add', '.')
  git('commit', '--quiet', '-m', 'init')
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

test('sch-1: system items carry carries a Ready Item through a real Host and skips a Blocked Item', () => {
  rmSync(log, { force: true })
  const blocked = system(['items', 'carry', 'a-2', '--repo', project])
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /blocked by a-1/i)
  assert.equal(JSON.parse(blocked.stdout).outcome, 'skipped')
  assert.deepEqual(calls(), [])

  const carried = system(['items', 'carry', 'a-1', '--repo', project])
  const record = JSON.parse(carried.stdout) as { item: string; works: string[]; outcome: string; account: string | null; tokens: number; cost: number | null }
  assert.equal(record.item, 'a-1')
  assert.equal(record.works.length, 1)
  assert.equal(record.outcome, 'succeeded')
  assert.equal(record.account, 'fake-worker')
  assert.equal(carried.status, 1, 'exits 0 only when merged or held')
  assert.deepEqual(calls().map((l) => l.split(' ')[1]), ['implement'])
})

test('sch-2: system items carry --repo <path> without an Item ID runs a pass over two Ready Items through a real Host', () => {
  const passRepo = mkdtempSync(join(home, 'pass-repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', passRepo, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    encoding: 'utf8',
  })
  git('init', '--quiet', '-b', 'dev')
  writeFileSync(join(passRepo, 'STATUS.md'), '# Pass\n\nAim: smoke test\n\n## Items\n\n- [ ] p-1 First ready\n- [ ] p-2 Second ready\n- [ ] p-3 Blocked (after: p-1)\n')
  mkdirSync(join(passRepo, 'workflows'), { recursive: true })
  git('add', '.')
  git('commit', '--quiet', '-m', 'init')

  rmSync(log, { force: true })
  const res = system(['items', 'carry', '--repo', passRepo])
  const reportId = res.stdout.trim()
  assert.match(reportId, /^sha256:[0-9a-f]{64}$/, `expected report Artifact ID, got: ${res.stdout}`)
  const cat = system(['artifact', 'cat', reportId])
  assert.equal(cat.status, 0, cat.stderr)
  assert.match(cat.stdout, /\| p-1 \|.*\| succeeded \| fake-worker \|/)
  assert.match(cat.stdout, /\| p-2 \|.*\| succeeded \| fake-worker \|/)
  assert.deepEqual(calls().map((l) => l.split(' ')[1]), ['implement', 'implement'])
})

test('sch-5: system items carry --schedule <file> --check starts nothing and names a repository whose status cannot be read', () => {
  const schedule = join(home, 'check.yaml')
  writeFileSync(schedule, `kind: items\nrepositories: [${project}, ${join(home, 'no-such-repo')}]\nat: daily\n`)
  rmSync(log, { force: true })
  const res = system(['items', 'carry', '--schedule', schedule, '--check'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /no-such-repo: status cannot be read/)
  assert.equal(res.stdout, '')
  assert.deepEqual(calls(), [])
})

test('pass-1: bad `at` in Schedule and a Host that never answers each notify a local HTTP listener and exit 1', async () => {
  const received: string[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('expected TCP address')
  const url = `http://127.0.0.1:${addr.port}/notify`
  const emptyHome = mkdtempSync(join(home, 'no-host-'))
  try {
    const badAt = join(home, 'bad-at.yaml')
    writeFileSync(badAt, `kind: items\nrepositories: [${project}]\nat: "not-a-valid-calendar-expression"\n`)
    const bad = await cli.runAsync(['items', 'carry', '--schedule', badAt], { env: { SYSTEM_SCHEDULE_NOTIFY_URL: url } }).done
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /at:/)
    assert.equal(received.length, 1)
    assert.ok(!received[0]!.includes('\n'))
    assert.match(received[0]!, /at:/)

    const good = join(home, 'good.yaml')
    writeFileSync(good, `kind: items\nrepositories: [${project}]\nat: daily\n`)
    const dead = await cli.runAsync(['items', 'carry', '--schedule', good], {
      env: {
        DSH_HOME: emptyHome,
        SYSTEM_SCHEDULE_NOTIFY_URL: url,
        SYSTEM_CONNECT_RETRY_MS: '50',
        SYSTEM_SCHEDULE_HOST_WAIT_MS: '150',
        SYSTEM_SCHEDULE_HOST_WAIT_INTERVAL_MS: '50',
      },
    }).done
    assert.equal(dead.status, 1)
    assert.match(dead.stderr, /Host/i)
    assert.equal(received.length, 2)
    assert.ok(!received[1]!.includes('\n'))
    assert.match(received[1]!, /cause:.*Host/i)
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    rmSync(emptyHome, { recursive: true, force: true })
  }
})
