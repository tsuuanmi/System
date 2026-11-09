/**
 * M5 gate on the real profile: the Software Engineering Workflow publishes the exact checked commit as one draft pull request, or merges it onto an allowlisted base. Remote: a real bare git repository
 * (file://) and a fake GitHub API in its own process; Workers run on the fake
 * CLI, in a Host that the tests kill and start again. The publish tests are
 * split over tests/publish*.test.ts so they run in parallel; the shared setup
 * is test-support/publish.ts.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mainOf, publishHarness } from '../test-support/publish.ts'

const { SE, SE_MERGE, system, restart, github, profile, project, show, commitOf } = publishHarness('system-publish')

test('the exact checked commit is pushed to system/<work> and one draft pull request opened; running again changes nothing', async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const ran = system(['work', 'submit', '--workflow', SE, '--input', p.task])
  assert.equal(ran.status, 0, ran.stderr)
  const workId = ran.stdout.trim()
  const record = show(workId)
  const verified = record.events.find((e) => e.type === 'verified')!
  const published = record.events.find((e) => e.type === 'effect-observed')!
  assert.equal(published.state, 'applied')
  assert.equal(p.branchOf(workId), commitOf(verified.subject!))
  assert.deepEqual((await gh.state()).pulls.map((pr) => [pr.head, pr.draft]), [[`system/${workId.replace('work:', '')}`, true]])
  assert.equal(published.detail!.pullRequest, '1')
  const events = record.events.length
  assert.equal(system(['work', 'run', workId]).status, 0)
  assert.equal(show(workId).events.length, events)
  assert.equal((await gh.state()).pulls.length, 1)
  assert.ok((await gh.state()).calls.every((c) => !/merge/i.test(c)))
})

test('a Work with merge: true moves main to exactly the checked commit through the merge queue; running again changes nothing', async () => {
  const p = project()
  const gh = await github('--bare', p.bare)
  profile(gh.url, '[main]')
  await restart()
  const ran = system(['work', 'submit', '--workflow', SE_MERGE, '--input', p.task])
  assert.equal(ran.status, 0, ran.stderr)
  const workId = ran.stdout.trim()
  const record = show(workId)
  const commit = commitOf(record.events.find((e) => e.type === 'verified')!.subject!)
  const published = record.events.find((e) => e.type === 'effect-observed')!
  assert.equal(published.state, 'applied')
  assert.equal(p.branchOf(workId), commit)
  assert.equal(mainOf(p.bare), commit, 'main is the checked commit: it already held the tip, so nothing new to check')
  assert.deepEqual([published.detail!.merged, published.detail!.mergeCommit], ['true', commit])
  const { pulls, calls } = await gh.state()
  assert.deepEqual(pulls.map((pr) => [pr.head, pr.draft]), [[`system/${workId.replace('work:', '')}`, false]])
  assert.equal(calls.filter((c) => c.startsWith('PUT ')).length, 0, 'GitHub\'s merge endpoint is not used')
  const events = record.events.length
  assert.equal(system(['work', 'run', workId]).status, 0)
  assert.equal(show(workId).events.length, events)
  assert.equal(mainOf(p.bare), commit)
})

test('a profile whose base is not in mergeInto refuses a Workflow that merges, at admission', async () => {
  const gh = await github()
  profile(gh.url)
  await restart()
  const p = project()
  const refused = system(['work', 'submit', '--workflow', SE_MERGE, '--input', p.task])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stdout + refused.stderr, /base main is not in mergeInto \[\]/)
  assert.equal((await gh.state()).pulls.length, 0)
})

