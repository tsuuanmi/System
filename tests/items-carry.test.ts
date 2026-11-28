/**
 * Smoke test for `system items carry <id> --repo <path>` (Item sch-1) through a real Host with the `fakes` row.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
