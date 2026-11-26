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
import { describe, test } from 'node:test'
import { createPublishEnv, mainOf } from '../test-support/publish.ts'

describe('publish crash recovery', { concurrency: true }, () => {
test('a host killed once main moved but before it heard back is reconciled as applied: nothing merged twice', async () => {
  const h = createPublishEnv('sys-pub-c1')
  try {
    await h.init()
    const p = h.project()
    // The remote kills the Host as soon as main moves, before the push returns.
    writeFileSync(join(p.bare, 'hooks', 'post-receive'), `#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && kill -9 "$(cat ${h.hostPid})"; done\nexit 0\n`, { mode: 0o755 })
    const gh = await h.github('--bare', p.bare)
    h.profile(gh.url, '[main]')
    await h.restart()
    const crashed = await h.systemAsync(['work', 'submit', '--workflow', h.SE_MERGE, '--input', p.task])
    assert.notEqual(crashed.status, 0)
    const workId = crashed.stdout.trim()
    rmSync(join(p.bare, 'hooks', 'post-receive'))
    const moved = mainOf(p.bare)
    await h.restart()
    h.assertRecovered(workId)
    const resumed = await h.systemAsync(['work', 'run', workId])
    assert.equal(resumed.status, 0, resumed.stderr)
    const observed = h.show(workId).events.filter((e) => e.type === 'effect-observed')
    assert.deepEqual(observed.map((e) => e.state), ['applied'])
    assert.match(observed[0]!.reason!, /main holds/)
    assert.equal(mainOf(p.bare), moved, 'main did not move again')
    assert.equal(moved, h.commitOf(h.show(workId).state.steps.implement!.outputs.change!))
  } finally {
    await h.close()
  }
})

test('a host killed after the pull request was created but before it heard back is reconciled: no second pull request', async () => {
  const h = createPublishEnv('sys-pub-c2')
  try {
    await h.init()
    const gh = await h.github('--kill-host-on-create', h.hostPid)
    h.profile(gh.url)
    await h.restart()
    const p = h.project()
    const crashed = await h.systemAsync(['work', 'submit', '--workflow', h.SE, '--input', p.task])
    assert.notEqual(crashed.status, 0)
    const workId = crashed.stdout.trim()
    await h.restart()
    h.assertRecovered(workId)
    const resumed = await h.systemAsync(['work', 'run', workId])
    assert.equal(resumed.status, 0, resumed.stderr)
    const observed = h.show(workId).events.filter((e) => e.type === 'effect-observed')
    assert.deepEqual(observed.map((e) => e.state), ['applied'])
    assert.match(observed[0]!.reason!, /pull request #1 is open/)
    assert.equal((await gh.state()).pulls.length, 1)
  } finally {
    await h.close()
  }
})

test('a host killed during the push, before the remote took it, is reconciled as absent and published once', async () => {
  const h = createPublishEnv('sys-pub-c3')
  try {
    await h.init()
    const gh = await h.github()
    h.profile(gh.url)
    await h.restart()
    const p = h.project()
    const marker = join(h.home, `killed-${Date.now()}`)
    const hook = join(p.bare, 'hooks', 'pre-receive')
    writeFileSync(hook, `#!/bin/sh\nif [ ! -f ${marker} ]; then touch ${marker}; kill -9 "$(cat ${h.hostPid})"; exit 1; fi\nexit 0\n`)
    chmodSync(hook, 0o755)
    const crashed = await h.systemAsync(['work', 'submit', '--workflow', h.SE, '--input', p.task])
    assert.notEqual(crashed.status, 0)
    const workId = crashed.stdout.trim()
    await h.restart()
    h.assertRecovered(workId)
    assert.equal((await gh.state()).pulls.length, 0)
    const resumed = await h.systemAsync(['work', 'run', workId])
    assert.equal(resumed.status, 0, resumed.stderr)
    assert.deepEqual(h.show(workId).events.filter((e) => e.type === 'effect-observed').map((e) => e.state), ['absent', 'applied'])
    assert.equal((await gh.state()).pulls.length, 1)
    assert.equal(p.branchOf(workId), h.commitOf(h.show(workId).state.steps.implement!.outputs.change!))
  } finally {
    await h.close()
  }
})
})

