/**
 * M5 gate on the real profile: marking the pull request ready needs a human at a real terminal. Remote: a real bare git repository
 * (file://) and a fake GitHub API in its own process; Workers run on the fake
 * CLI, in a Host that the tests kill and start again. The publish tests are
 * split over tests/publish*.test.ts so they run in parallel; the shared setup
 * is test-support/publish.ts.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { repo } from '../test-support/cli.ts'
import { publishHarness, type Event } from '../test-support/publish.ts'

const { home, env, SE, system, restart, github, profile, project, show } = publishHarness('system-publish-approval')

const hasScript = spawnSync('script', ['--version']).status === 0

/** Run `system` on a real pseudo-terminal, typing `input`. */
function onTerminal(args: string[], input: string) {
  const command = [process.execPath, join(repo, 'bin', 'system'), ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
  return spawnSync('script', ['-qec', command, '/dev/null'], { env: { ...env, SYSTEM_CALLER: '' }, input, encoding: 'utf8', timeout: 180_000 })
}

test('marking the pull request ready waits for a human at a terminal; an agent or a pipe cannot approve', { skip: !hasScript && 'needs script(1) for a pseudo-terminal' }, async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const ready = join(home, 'ready.yaml')
  writeFileSync(ready, readFileSync(SE, 'utf8').replace('      requires: [checks.checks]\n  - id: accept', '      requires: [checks.checks]\n      params:\n        ready: true\n  - id: accept'))
  const held = system(['work', 'submit', '--workflow', ready, '--input', p.task])
  assert.equal(held.status, 3, held.stderr)
  const workId = held.stdout.trim()
  assert.match(show(workId).state.reason!, /publish awaits operator approval: marking the pull request ready for review/)
  assert.equal((await gh.state()).pulls.length, 0)

  const piped = system(['approve', workId, '--reason', 'ok'])
  assert.equal(piped.status, 1)
  assert.match(piped.stderr, /needs a human at a terminal/)
  const wrong = onTerminal(['approve', workId, '--reason', 'ok'], 'not-the-id\n')
  assert.notEqual(wrong.status, 0)
  assert.match(wrong.stdout, /Nothing is decided unless you type exactly [0-9a-f]{8}/)
  assert.match(wrong.stdout, /system: the confirmation did not match; nothing was decided\r?\n/)
  assert.doesNotMatch(wrong.stdout, /\n\s+at /, 'a mistyped confirmation prints one line, not a stack')
  assert.equal(show(workId).state.status, 'held')

  const approved = onTerminal(['approve', workId, '--reason', 'reviewed'], `${workId.slice(5, 13)}\n`)
  assert.equal(approved.status, 0, approved.stdout)
  assert.equal(show(workId).state.status, 'succeeded')
  assert.deepEqual((await gh.state()).pulls.map((pr) => pr.draft), [false])
  const decided = show(workId).events.find((e) => e.type === 'decided') as Event & { caller: { type: string; operatorId: string } }
  assert.deepEqual([decided.caller.type, decided.caller.operatorId], ['human', 'tester'])
})

test('a human can deny instead; the Work fails and nothing is published', { skip: !hasScript && 'needs script(1) for a pseudo-terminal' }, async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const ready = join(home, 'ready-deny.yaml')
  writeFileSync(ready, readFileSync(SE, 'utf8').replace('      requires: [checks.checks]\n  - id: accept', '      requires: [checks.checks]\n      params:\n        ready: true\n  - id: accept'))
  const workId = system(['work', 'submit', '--workflow', ready, '--input', p.task]).stdout.trim()
  const denied = onTerminal(['deny', workId, '--reason', 'not now'], `${workId.slice(5, 13)}\n`)
  assert.equal(denied.status, 1, denied.stdout)
  assert.match(show(workId).state.reason!, /publish denied by tester: not now/)
  assert.equal((await gh.state()).pulls.length, 0)
})
