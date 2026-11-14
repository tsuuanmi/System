/**
 * M5 gate on the real profile: a host killed on either side of the remote effect is reconciled without a duplicate. Remote: a real bare git repository
 * (file://) and a fake GitHub API in its own process; Workers run on the fake
 * CLI, in a Host that the tests kill and start again. The publish tests are
 * split over tests/publish*.test.ts so they run in parallel; the shared setup
 * is test-support/publish.ts.
 */
import assert from 'node:assert/strict'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { mainOf, publishHarness } from '../test-support/publish.ts'

const { home, hostPid, SE, SE_MERGE, system, restart, github, profile, project, show, assertRecovered, commitOf } = publishHarness('system-publish-crash')

test('a host killed once main moved but before it heard back is reconciled as applied: nothing merged twice', async () => {
  const p = project()
  // The remote kills the Host as soon as main moves, before the push returns.
  writeFileSync(join(p.bare, 'hooks', 'post-receive'), `#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && kill -9 "$(cat ${hostPid})"; done\nexit 0\n`, { mode: 0o755 })
  const gh = await github('--bare', p.bare)
  profile(gh.url, '[main]')
  await restart()
  const crashed = system(['work', 'submit', '--workflow', SE_MERGE, '--input', p.task])
  assert.notEqual(crashed.status, 0)
  const workId = crashed.stdout.trim()
  rmSync(join(p.bare, 'hooks', 'post-receive'))
  const moved = mainOf(p.bare)
  await restart()
  assertRecovered(workId)
  const resumed = system(['work', 'run', workId])
  assert.equal(resumed.status, 0, resumed.stderr)
  const observed = show(workId).events.filter((e) => e.type === 'effect-observed')
  assert.deepEqual(observed.map((e) => e.state), ['applied'])
  assert.match(observed[0]!.reason!, /main holds/)
  assert.equal(mainOf(p.bare), moved, 'main did not move again')
  assert.equal(moved, commitOf(show(workId).state.steps.implement!.outputs.change!))
})

test('a host killed after the pull request was created but before it heard back is reconciled: no second pull request', async () => {
  const gh = await github('--kill-host-on-create', hostPid)
  profile(gh.url)
  await restart()
  const p = project()
  const crashed = system(['work', 'submit', '--workflow', SE, '--input', p.task])
  assert.notEqual(crashed.status, 0)
  const workId = crashed.stdout.trim()
  await restart()
  assertRecovered(workId)
  const resumed = system(['work', 'run', workId])
  assert.equal(resumed.status, 0, resumed.stderr)
  const observed = show(workId).events.filter((e) => e.type === 'effect-observed')
  assert.deepEqual(observed.map((e) => e.state), ['applied'])
  assert.match(observed[0]!.reason!, /pull request #1 is open/)
  assert.equal((await gh.state()).pulls.length, 1)
})

test('a host killed during the push, before the remote took it, is reconciled as absent and published once', async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const marker = join(home, `killed-${Date.now()}`)
  const hook = join(p.bare, 'hooks', 'pre-receive')
  writeFileSync(hook, `#!/bin/sh\nif [ ! -f ${marker} ]; then touch ${marker}; kill -9 "$(cat ${hostPid})"; exit 1; fi\nexit 0\n`)
  chmodSync(hook, 0o755)
  const crashed = system(['work', 'submit', '--workflow', SE, '--input', p.task])
  assert.notEqual(crashed.status, 0)
  const workId = crashed.stdout.trim()
  await restart()
  assertRecovered(workId)
  assert.equal((await gh.state()).pulls.length, 0)
  const resumed = system(['work', 'run', workId])
  assert.equal(resumed.status, 0, resumed.stderr)
  assert.deepEqual(show(workId).events.filter((e) => e.type === 'effect-observed').map((e) => e.state), ['absent', 'applied'])
  assert.equal((await gh.state()).pulls.length, 1)
  assert.equal(p.branchOf(workId), commitOf(show(workId).state.steps.implement!.outputs.change!))
})

