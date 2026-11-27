/**
 * `git.publish` against a real bare git remote (file://) and a fake GitHub
 * REST/GraphQL API recording every call.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import type { Artifacts } from '@system/artifacts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { GIT_TREE_KIND, gitTreeSchema, pin, snapshot, type EffectIntent, type EffectOutcome } from '@system/work'
import { githubPublisher, type PublishConfig } from '../src/github.ts'

const root = mkdtempSync(join(tmpdir(), 'system-effects-'))
interface Pull { number: number; head: string; base: string; draft: boolean; title: string; node_id: string; merged?: boolean; mergeCommit?: string }
const calls: string[] = []
let pulls: Pull[] = []
let api = ''
let bareOf = ''
let server: Server

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      calls.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? '-'}`)
      const url = new URL(req.url!, 'http://x')
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      const headSha = (branch: string) => {
        try { return execFileSync('git', ['-C', bareOf, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
      }
      const view = (p: Pull) => ({ ...p, html_url: `https://github.example/pull/${p.number}`, base: { ref: p.base }, head: { ref: p.head, sha: headSha(p.head) }, merged_at: p.merged ? '2026-11-06T00:00:00Z' : null, merge_commit_sha: p.mergeCommit ?? null })
      if (req.method === 'GET' && url.pathname === '/repos/tester/scratch/pulls') {
        const head = url.searchParams.get('head')!.split(':')[1]
        const state = url.searchParams.get('state') ?? 'open'
        return send(200, pulls.filter((p) => p.head === head && (state === 'all' || !p.merged)).map(view))
      }
      if (req.method === 'POST' && url.pathname === '/repos/tester/scratch/pulls') {
        const input = JSON.parse(body) as { head: string; base: string; draft: boolean; title: string }
        const pull = { number: pulls.length + 1, ...input, node_id: `PR_${pulls.length + 1}` }
        pulls.push(pull)
        return send(201, view(pull))
      }
      if (req.method === 'POST' && url.pathname === '/graphql') {
        const { variables } = JSON.parse(body) as { variables: { id: string } }
        const pull = pulls.find((p) => p.node_id === variables.id)!
        pull.draft = false
        return send(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } })
      }
      send(404, { message: 'not found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

const store = () => memoryArtifacts({ ...GIT_TREE_KIND, content: gitTreeSchema }).artifacts

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

/** A working repository whose `origin` is a fresh bare repository, and a commit to publish. */
function setup(text = 'change\n') {
  const bare = mkdtempSync(join(root, 'remote-'))
  execFileSync('git', ['init', '--bare', '--quiet', bare])
  const work = mkdtempSync(join(root, 'work-'))
  const run = (...args: string[]) => execFileSync('git', ['-C', work, ...args], { env, encoding: 'utf8' }).trim()
  run('init', '--quiet', '-b', 'main')
  writeFileSync(join(work, 'README.md'), 'base\n')
  run('add', '.')
  run('commit', '--quiet', '-m', 'base')
  run('remote', 'add', 'origin', `file://${bare}`)
  run('push', '--quiet', 'origin', 'main')
  writeFileSync(join(work, 'CHANGE.md'), text)
  run('add', '.')
  run('commit', '--quiet', '-m', 'change')
  bareOf = bare
  return { bare, work, run, remoteRef: (branch: string) => execFileSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' }).trim() }
}

/** The HEAD commit as an attempt's capture leaves it: a git-tree Artifact, pinned. */
async function subjectOf(artifacts: Artifacts, work: string): Promise<string> {
  const tree = await snapshot(work)
  await pin(tree.repository, tree.commit)
  return (await artifacts.put({ ...GIT_TREE_KIND, content: tree, classification: 'local-private', producer: { type: 'worker', ref: 't' } })).id
}

const config = (extra: Partial<PublishConfig> = {}): PublishConfig => ({ remote: 'origin', base: 'main', mergeInto: [], apiUrl: api, repository: 'tester/scratch', ...extra })
const intent = (subject: string, params: EffectIntent['params'] = {}, workId = 'work:1111-aaaa'): EffectIntent => ({ operationId: `op:${subject.slice(7)}`, workId, stepId: 'publish', capability: 'git.publish', subject, params })

function fresh() {
  calls.length = 0
  pulls = []
}

test('apply pushes the exact commit to system/<work> and opens one draft pull request', async () => {
  fresh()
  const artifacts = store()
  const { work, remoteRef } = setup()
  const subject = await subjectOf(artifacts, work)
  const publisher = githubPublisher(artifacts, { token: async () => 'ghs_secret' }, config())
  const outcome = await publisher.apply(intent(subject))
  const commit = (await snapshot(work)).commit
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.equal(remoteRef('system/1111-aaaa'), commit)
  assert.equal(pulls.length, 1)
  assert.deepEqual([pulls[0]!.head, pulls[0]!.base, pulls[0]!.draft], ['system/1111-aaaa', 'main', true])
  assert.deepEqual(outcome.detail, { repository: 'tester/scratch', branch: 'system/1111-aaaa', commit, pullRequest: '1', url: 'https://github.example/pull/1', draft: 'true' })
  assert.ok(calls.every((c) => c.endsWith('auth=Bearer ghs_secret')))
})

test('applying the same operation again and reconciling it never opens a second pull request', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config())
  const i = intent(await subjectOf(artifacts, work))
  assert.equal((await publisher.reconcile(i)).state, 'absent')
  await publisher.apply(i)
  const again = await publisher.apply(i)
  assert.equal(again.state, 'applied')
  assert.equal(pulls.length, 1)
  const found = await publisher.reconcile(i)
  assert.equal(found.state, 'applied')
  assert.equal(found.state === 'applied' && found.detail.pullRequest, '1')
})

test('a branch pushed before a lost host opened the pull request reconciles as absent; apply then opens it once', async () => {
  fresh()
  const artifacts = store()
  const { work, run } = setup()
  const i = intent(await subjectOf(artifacts, work))
  run('push', '--quiet', 'origin', 'HEAD:refs/heads/system/1111-aaaa')
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config())
  const found = await publisher.reconcile(i)
  assert.equal(found.state, 'absent')
  assert.match(found.reason, /branch system\/1111-aaaa holds the commit, but no open pull request/)
  assert.equal((await publisher.apply(i)).state, 'applied')
  assert.equal(pulls.length, 1)
})

test('a new subject moves the system branch from the commit it last published, reusing the pull request', async () => {
  fresh()
  const artifacts = store()
  const { work, run, remoteRef } = setup()
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config())
  await publisher.apply(intent(await subjectOf(artifacts, work)))
  writeFileSync(join(work, 'CHANGE.md'), 'reworked\n')
  run('commit', '--quiet', '-am', 'rework')
  const second = await publisher.apply(intent(await subjectOf(artifacts, work)))
  assert.equal(second.state, 'applied')
  assert.equal(remoteRef('system/1111-aaaa'), (await snapshot(work)).commit)
  assert.equal(pulls.length, 1)
})

test('a system branch holding a commit System did not publish is refused, not overwritten', async () => {
  fresh()
  const artifacts = store()
  const { work, run, remoteRef } = setup()
  // Someone else's commit (the base, never captured by System) on the System branch.
  run('push', '--quiet', 'origin', 'HEAD~1:refs/heads/system/1111-aaaa')
  const foreign = remoteRef('system/1111-aaaa')
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config())
  const i = intent(await subjectOf(artifacts, work))
  await assert.rejects(() => publisher.apply(i), /system\/1111-aaaa holds .* which System did not publish/)
  assert.equal(remoteRef('system/1111-aaaa'), foreign)
  const found = await publisher.reconcile(i)
  assert.equal(found.state, 'absent')
  assert.equal(pulls.length, 0)
})

test('ready: true needs approval, then marks the draft ready; other parameters are refused', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config())
  const i = intent(await subjectOf(artifacts, work), { ready: true })
  assert.equal(publisher.approval(intent('sha256:' + '0'.repeat(64))), undefined)
  assert.equal(publisher.approval(i), 'marking the pull request ready for review')
  const outcome = await publisher.apply(i)
  assert.equal(outcome.detail.draft, 'false')
  assert.equal(pulls[0]!.draft, false)
  assert.throws(() => publisher.validate('git.publish', { base: 'dev' }), /unknown parameter base/)
  assert.throws(() => publisher.validate('git.publish', { ready: 'yes' }), /ready must be true or false/)
  assert.doesNotThrow(() => publisher.validate('git.publish', { ready: false }))
})

test('an unreachable remote reconciles as unknown, and apply throws', async () => {
  fresh()
  const artifacts = store()
  const { work, run } = setup()
  run('remote', 'set-url', 'origin', `file://${join(root, 'no-such-remote')}`)
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config())
  const i = intent(await subjectOf(artifacts, work))
  const found = await publisher.reconcile(i)
  assert.equal(found.state, 'unknown')
  await assert.rejects(() => publisher.apply(i))
  assert.equal(pulls.length, 0)
})

test('the token reaches git only through its environment, never its arguments', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  const seen: { args: string[]; env: Record<string, string> }[] = []
  const recordingGit = async (_dir: string, args: string[], extra: Record<string, string> = {}) => {
    seen.push({ args, env: extra })
    return args[0] === 'remote' ? 'https://github.com/tester/scratch.git\n' : ''
  }
  const publisher = githubPublisher(artifacts, { token: async () => 'ghs_secret', git: recordingGit }, config())
  assert.equal((await publisher.apply(intent(await subjectOf(artifacts, work)))).state, 'applied')
  const header = `Authorization: Basic ${Buffer.from('x-access-token:ghs_secret').toString('base64')}`
  for (const s of seen) assert.ok(!s.args.join(' ').includes('ghs_secret'), s.args.join(' '))
  const network = seen.filter((s) => s.args[0] === 'push' || s.args[0] === 'ls-remote')
  assert.deepEqual(network.map((s) => s.args[0]), ['ls-remote', 'push'])
  assert.ok(network.every((s) => s.env.GIT_CONFIG_VALUE_0 === header && s.env.GIT_CONFIG_KEY_0 === 'http.extraHeader'))
})

test('without merge: true, apply never calls the merge endpoint', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config({ mergeInto: ['main'] }))
  await publisher.apply(intent(await subjectOf(artifacts, work)))
  assert.ok(calls.every((c) => !/merge/i.test(c)))
})

const mergeConfig = (extra: Partial<PublishConfig> = {}) => config({ mergeInto: ['main'], ...extra })
const merging = { merge: true }
const mergeCalls = () => calls.filter((c) => c.startsWith('PUT '))

test('merge: true is refused unless the base is on the mergeInto allowlist, naming it; and not with ready', () => {
  const artifacts = store()
  const open = githubPublisher(artifacts, { token: async () => undefined }, config({ base: 'dev', mergeInto: ['dev'] }))
  assert.doesNotThrow(() => open.validate('git.publish', { merge: true }))
  assert.doesNotThrow(() => open.validate('git.publish', { merge: false }))
  assert.throws(() => open.validate('git.publish', { merge: 'yes' }), /merge must be true or false/)
  assert.throws(() => open.validate('git.publish', { merge: true, ready: true }), /merge and ready cannot be combined/)
  for (const mergeInto of [[], ['dev']]) {
    const closed = githubPublisher(artifacts, { token: async () => undefined }, config({ base: 'main', mergeInto }))
    assert.throws(() => closed.validate('git.publish', { merge: true }), /base main is not in mergeInto \[.*\]/)
    assert.doesNotThrow(() => closed.validate('git.publish', { merge: false }))
  }
})

test('merge needs no approval; ready still does', async () => {
  const artifacts = store()
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
  assert.equal(publisher.approval(intent('sha256:' + '0'.repeat(64), merging)), undefined)
  assert.equal(publisher.approval(intent('sha256:' + '0'.repeat(64), { ready: true })), 'marking the pull request ready for review')
})

/** A publisher whose merge queue checks a merge commit with `verdicts` in turn (pass when used up); what it checked is in `checked`. */
function queue(artifacts: Artifacts, verdicts: { verdict: 'pass' | 'fail' | 'hold'; reason: string; verdicts?: string[] }[] = [], during?: () => void) {
  const checked: { commit: string; parent?: string }[] = []
  const publisher = githubPublisher(artifacts, {
    token: async () => undefined,
    async check(subject) {
      const read = artifacts.get(subject)
      const tree = read.state === 'stored' ? read.envelope.content as { commit: string; parent?: string } : { commit: '' }
      checked.push({ commit: tree.commit, parent: tree.parent })
      during?.()
      return { ...(verdicts.shift() ?? { verdict: 'pass', reason: 'all checks passed' }), evidence: [] }
    },
  }, mergeConfig())
  return { publisher, checked }
}
const parents = (bare: string, commit: string) => execFileSync('git', ['-C', bare, 'rev-list', '--parents', '-n', '1', commit], { encoding: 'utf8' }).trim().split(' ').slice(1)

test('merge: a change that already contains the tip moves main to it, with no merge call and no check again', async () => {
  fresh()
  const artifacts = store()
  const { work, remoteRef } = setup()
  const { publisher, checked } = queue(artifacts)
  const outcome = await publisher.apply(intent(await subjectOf(artifacts, work), merging))
  const commit = (await snapshot(work)).commit
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.equal(remoteRef('main'), commit, 'main is exactly the checked commit')
  assert.throws(() => remoteRef('system/1111-aaaa'), 'the merged branch is deleted')
  assert.deepEqual([outcome.detail.merged, outcome.detail.mergeCommit, outcome.detail.draft, outcome.detail.branchDeleted], ['true', commit, 'false', 'true'])
  assert.deepEqual([checked, mergeCalls()], [[], []])
  assert.equal(pulls[0]!.draft, false)
  // Again: main already holds it; nothing is pushed or checked.
  calls.length = 0
  const again = await publisher.apply(intent(await subjectOf(artifacts, work), merging))
  assert.equal(again.state, 'applied', again.reason)
  assert.equal(calls.filter((c) => !c.startsWith('GET ')).length, 0)
})

test('merge: two changes on the same tip; the second is merged only after its checks pass on a merge with the tip that has the first', async () => {
  fresh()
  const artifacts = store()
  const { work, run, bare, remoteRef } = setup()
  const first = await subjectOf(artifacts, work)
  const firstCommit = run('rev-parse', 'HEAD')
  run('checkout', '--quiet', '--detach', 'HEAD~1')
  writeFileSync(join(work, 'OTHER.md'), 'other\n')
  run('add', '.')
  run('commit', '--quiet', '-m', 'other')
  const second = await subjectOf(artifacts, work)
  const secondCommit = run('rev-parse', 'HEAD')
  const { publisher, checked } = queue(artifacts)
  // Both at once: the queue takes them one at a time.
  const [a, b] = await Promise.all([publisher.apply(intent(first, merging, 'work:1111-aaaa')), publisher.apply(intent(second, merging, 'work:2222-bbbb'))])
  assert.equal(a.state, 'applied', a.reason)
  assert.equal(b.state, 'applied', b.reason)
  // Whichever the queue took first went in as it is; the other was merged with it, checked, then pushed.
  const [ahead, after] = a.detail.checkedOn ? [b, a] : [b.detail.checkedOn ? a : b, a.detail.checkedOn ? a : b]
  assert.equal(ahead.detail.checkedOn, undefined)
  assert.deepEqual(checked, [{ commit: after.detail.mergeCommit, parent: ahead.detail.mergeCommit }], 'the later was checked on its merge with the earlier')
  assert.deepEqual(parents(bare, after.detail.mergeCommit!).sort(), [firstCommit, secondCommit].sort(), 'the merge commit joins exactly the two changes')
  assert.equal(parents(bare, after.detail.mergeCommit!)[0], ahead.detail.mergeCommit)
  assert.equal(remoteRef('main'), after.detail.mergeCommit)
  assert.equal(after.detail.checkedOn, ahead.detail.mergeCommit)
})

test('merge: a conflict with the tip fails naming the files; a failed check on the merge fails; main does not move', async (t) => {
  fresh()
  const artifacts = store()
  const { work, run, remoteRef } = setup()
  const first = await subjectOf(artifacts, work)
  run('checkout', '--quiet', '--detach', 'HEAD~1')
  writeFileSync(join(work, 'CHANGE.md'), 'a different change\n')
  run('add', '.')
  run('commit', '--quiet', '-m', 'conflicting')
  const conflicting = await subjectOf(artifacts, work)
  run('checkout', '--quiet', '--detach', 'HEAD~1')
  writeFileSync(join(work, 'THIRD.md'), 'third\n')
  run('add', '.')
  run('commit', '--quiet', '-m', 'third')
  const third = await subjectOf(artifacts, work)
  const { publisher } = queue(artifacts, [{ verdict: 'fail', reason: 'failed: unit: a.test.ts "x": 1 !== 2' }])
  const merged = await publisher.apply(intent(first, merging, 'work:1111-aaaa'))
  const tip = remoteRef('main')
  const conflict: EffectOutcome & { rejected?: string } = await publisher.apply(intent(conflicting, merging, 'work:2222-bbbb'))
  assert.equal(conflict.state, 'failed')
  assert.match(conflict.reason, /merge conflict with main at [0-9a-f]{12}: CHANGE\.md/)
  assert.equal(conflict.cause, 'conflict')
  const failed: EffectOutcome & { rejected?: string } = await publisher.apply(intent(third, merging, 'work:3333-cccc'))
  assert.equal(failed.state, 'failed')
  assert.equal(failed.cause, undefined, 'a failed merge check is not Outside')
  assert.match(failed.reason, /checks on the merge with main at [0-9a-f]{12}: fail: failed: unit: a\.test\.ts "x": 1 !== 2/)
  assert.equal(remoteRef('main'), tip)
  assert.equal(merged.detail.mergeCommit, tip)
  for (const [outcome, rejected] of [[conflict, 'conflict'], [failed, 'merge-check']] as const) {
    await t.test(`observed ${rejected} carries the pinned base tip`, () => {
      assert.equal(outcome.rejected, rejected)
      assert.equal(outcome.detail.baseCommit, tip)
      assert.ok(outcome.detail.base)
      const base = artifacts.get(outcome.detail.base)
      assert.ok(base.state === 'stored')
      assert.equal(base.envelope.kind, 'git-tree')
      assert.deepEqual(base.envelope.content, { repository: work, commit: tip, tree: run('rev-parse', `${tip}^{tree}`), parent: tip })
      assert.equal(run('rev-parse', `refs/system/artifacts/${tip}`), tip)
    })
  }
  const unchecked: EffectOutcome & { rejected?: string } = await githubPublisher(artifacts, { token: async () => undefined }, mergeConfig()).apply(intent(third, merging, 'work:4444-dddd'))
  assert.equal(unchecked.state, 'failed')
  assert.match(unchecked.reason, /no checks to run/)
  assert.equal(unchecked.rejected, undefined)
})

test('merge: a held check leaves main alone and names the merge commit; once that commit is approved it is pushed as it is, with no check again', async () => {
  fresh()
  const artifacts = store()
  const { work, run, remoteRef } = setup()
  const first = await subjectOf(artifacts, work)
  run('checkout', '--quiet', '--detach', 'HEAD~1')
  writeFileSync(join(work, 'OTHER.md'), 'other\n')
  run('add', '.')
  run('commit', '--quiet', '-m', 'other')
  const second = await subjectOf(artifacts, work)
  // main moves on with the first change, so the second needs a merge.
  const ahead = queue(artifacts)
  assert.equal((await ahead.publisher.apply(intent(first, merging, 'work:1111-aaaa'))).state, 'applied')
  const tip = remoteRef('main')
  const verdict = 'sha256:' + 'b'.repeat(64)
  const { publisher, checked } = queue(artifacts, [{ verdict: 'hold', reason: 'inconclusive: flaky', verdicts: [verdict] }])
  const held: EffectOutcome & { held?: string } = await publisher.apply(intent(second, merging))
  assert.equal(held.state, 'failed')
  assert.equal(held.rejected, undefined)
  assert.ok(held.held, 'the outcome names the merge commit to approve')
  assert.equal(held.detail.verdicts, verdict)
  assert.equal(remoteRef('main'), tip)
  const read = artifacts.get(held.held!)
  assert.ok(read.state === 'stored')
  const merge = (read.envelope.content as { commit: string }).commit
  // Approved: the same merge commit goes in, and nothing is checked again.
  const done = await publisher.apply({ ...intent(second, merging), approvedMerge: held.held })
  assert.equal(done.state, 'applied', done.reason)
  assert.equal(checked.length, 1)
  assert.equal(remoteRef('main'), merge)
  assert.equal(done.detail.mergeCommit, merge)
})

/**
 * Item gate-1: the base holds `.system/checks.yaml` with `gates` (a list of globs); main moves on by editing a line far from the
 * gates, so the change merges cleanly; the change, made on the base, rewrites `.system/checks.yaml` through `edit` (when given) and writes `files`.
 */
async function gatedChange(artifacts: Artifacts, files: Record<string, string>, gates = '[".system/checks.yaml", "packages/effects/**"]', edit?: (text: string) => string) {
  const w = setup()
  const base = w.run('rev-parse', 'HEAD~1')
  w.run('checkout', '--quiet', '--detach', base)
  mkdirSync(join(w.work, '.system'), { recursive: true })
  const gap = '\n'.repeat(4)
  const original = `gates: ${gates}\n${gap}checks: []\n${gap}tip: 0\n`
  writeFileSync(join(w.work, '.system/checks.yaml'), original)
  w.run('add', '.')
  w.run('commit', '--quiet', '-m', 'gates')
  const withGates = w.run('rev-parse', 'HEAD')
  writeFileSync(join(w.work, '.system/checks.yaml'), original.replace('tip: 0', 'tip: 1'))
  w.run('commit', '--quiet', '-am', 'main moves on')
  w.run('push', '--quiet', 'origin', 'HEAD:main')
  const tip = w.run('rev-parse', 'HEAD')
  w.run('checkout', '--quiet', '--detach', withGates)
  if (edit) writeFileSync(join(w.work, '.system/checks.yaml'), edit(original))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(w.work, file)), { recursive: true })
    writeFileSync(join(w.work, file), text)
  }
  w.run('add', '.')
  w.run('commit', '--quiet', '-m', 'change')
  return { ...w, tip, subject: await subjectOf(artifacts, w.work) }
}

test('gate-1: a change to a gate path is held after its checks pass, naming the paths and the approval; approving that commit merges it without a check', async () => {
  fresh()
  const artifacts = store()
  const { subject, tip, remoteRef } = await gatedChange(artifacts, {}, undefined, (t) => t.replace('checks: []', 'checks: [x]'))
  const { publisher, checked } = queue(artifacts)
  const held: EffectOutcome & { held?: string } = await publisher.apply(intent(subject, merging, 'work:1111-aaaa'))
  assert.equal(held.state, 'failed')
  assert.ok(held.held, 'the outcome names the commit to approve')
  assert.match(held.reason, /gate paths \.system\/checks\.yaml/)
  assert.match(held.reason, /`system approve work:1111-aaaa` approves commit [0-9a-f]{40}/)
  assert.equal(checked.length, 1, 'the checks ran first')
  assert.equal(remoteRef('main'), tip, 'nothing merged')
  const done = await publisher.apply({ ...intent(subject, merging, 'work:1111-aaaa'), approvedMerge: held.held })
  assert.equal(done.state, 'applied', done.reason)
  assert.equal(checked.length, 1)
  assert.equal(remoteRef('main'), done.detail.mergeCommit)
})

test('gate-1: a change elsewhere merges as today', async () => {
  fresh()
  const artifacts = store()
  const { subject, remoteRef } = await gatedChange(artifacts, { 'docs/NOTE.md': 'note\n' })
  const { publisher } = queue(artifacts)
  const outcome = await publisher.apply(intent(subject, merging))
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.equal(remoteRef('main'), outcome.detail.mergeCommit)
})

test('gate-1: a gate list the change itself adds does not apply to it', async () => {
  fresh()
  const artifacts = store()
  // The base has no gates; the change adds a list gating docs/** in the file it edits.
  const own = await gatedChange(artifacts, { 'docs/NOTE.md': 'note\n' }, '[]', (t) => t.replace('gates: []', 'gates: ["docs/**"]'))
  const outcome = await queue(artifacts).publisher.apply(intent(own.subject, merging))
  assert.equal(outcome.state, 'applied', outcome.reason)
})

test('gate-1: a gate list the change empties does not free it: the base\'s list decides', async () => {
  fresh()
  const artifacts = store()
  const emptied = await gatedChange(artifacts, {}, undefined, (t) => t.replace(/^gates:.*$/m, 'gates: []'))
  const held: EffectOutcome & { held?: string } = await queue(artifacts).publisher.apply(intent(emptied.subject, merging))
  assert.ok(held.held, held.reason)
})

test('merge: main moving while the merge is checked is caught by the lease; the change is merged and checked again on the new tip', async () => {
  fresh()
  const artifacts = store()
  const { work, run, bare, remoteRef } = setup()
  run('checkout', '--quiet', '--detach', 'HEAD~1')
  writeFileSync(join(work, 'MINE.md'), 'mine\n')
  run('add', '.')
  run('commit', '--quiet', '-m', 'mine')
  const mine = await subjectOf(artifacts, work)
  // main is ahead of the change's base, so the change needs a merge; then someone merges by hand once while System checks it.
  const other = mkdtempSync(join(root, 'other-'))
  execFileSync('git', ['clone', '--quiet', '-b', 'main', `file://${bare}`, other], { env })
  const commitOther = (file: string) => {
    writeFileSync(join(other, file), `${file}\n`)
    for (const args of [['add', '.'], ['commit', '--quiet', '-m', file], ['push', '--quiet', 'origin', 'HEAD:main']]) execFileSync('git', ['-C', other, ...args], { env })
  }
  commitOther('AHEAD.md')
  let moved = false
  const byHand = () => { if (!moved) { moved = true; commitOther('HAND.md') } }
  const { publisher, checked } = queue(artifacts, [], byHand)
  const outcome = await publisher.apply(intent(mine, merging))
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.equal(checked.length, 2, 'checked again on the tip that moved')
  assert.equal(checked[1]!.parent, execFileSync('git', ['-C', other, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
  assert.equal(remoteRef('main'), outcome.detail.mergeCommit)
})

test('reconcile with merge: true is applied once main holds the change, absent before, unknown when unreadable', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  const i = intent(await subjectOf(artifacts, work), merging)
  const { publisher } = queue(artifacts)
  const before = await publisher.reconcile(i)
  assert.equal(before.state, 'absent')
  assert.match(before.reason, /main does not hold/)
  await publisher.apply(i)
  calls.length = 0
  const merged = await publisher.reconcile(i)
  assert.equal(merged.state, 'applied', merged.reason)
  assert.equal(merged.state === 'applied' && merged.detail.merged, 'true')
  assert.equal(calls.filter((c) => !c.startsWith('GET ')).length, 0, 'reconcile only reads')
  const dead = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig({ remote: 'nowhere' }))
  assert.equal((await dead.reconcile(i)).state, 'unknown')
})

/** The remote refuses to delete any branch (a pre-receive hook), as branch protection would. */
function refuseDeletion(bare: string) {
  const hook = join(bare, 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do [ "$new" = 0000000000000000000000000000000000000000 ] && { echo "protected branch" >&2; exit 1; }; done\nexit 0\n', { mode: 0o755 })
}

test('merge: the system branch is deleted after the merge; without merge, or when the merge is refused, it stays', async () => {
  fresh()
  const artifacts = store()
  const kept = setup()
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
  const draft = await publisher.apply(intent(await subjectOf(artifacts, kept.work)))
  assert.equal(draft.state, 'applied', draft.reason)
  assert.ok(kept.remoteRef('system/1111-aaaa'), 'no merge: kept')
  assert.equal(draft.detail.branchDeleted, undefined)
  // A refused merge (conflict) keeps the branch.
  const clash = setup('one\n')
  const { publisher: queued } = queue(artifacts)
  const first = await queued.apply(intent(await subjectOf(artifacts, clash.work), merging, 'work:1111-aaaa'))
  assert.equal(first.state, 'applied', first.reason)
  const other = mkdtempSync(join(root, 'other-'))
  execFileSync('git', ['clone', '--quiet', '-b', 'main', `file://${clash.bare}`, other])
  const o = (...args: string[]) => execFileSync('git', ['-C', other, ...args], { env, encoding: 'utf8' })
  o('checkout', '--quiet', '-b', 'x', 'HEAD~1')
  writeFileSync(join(other, 'CHANGE.md'), 'two\n')
  o('add', '.'); o('commit', '--quiet', '-m', 'two')
  const refused = await queued.apply(intent(await subjectOf(artifacts, other), merging, 'work:2222-bbbb')) as EffectOutcome & { rejected?: string }
  assert.equal(refused.rejected, 'conflict')
  assert.equal(refused.detail.branchDeleted, undefined)
})

test('merge: a remote that refuses the deletion leaves the effect applied, recording why; reconcile and a repeat delete once it allows', async () => {
  fresh()
  const artifacts = store()
  const { work, bare, remoteRef } = setup()
  refuseDeletion(bare)
  const { publisher } = queue(artifacts)
  const i = intent(await subjectOf(artifacts, work), merging)
  const outcome = await publisher.apply(i)
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.equal(outcome.detail.branchDeleted, 'false')
  assert.match(outcome.detail.branchDeleteReason!, /protected branch/)
  assert.ok(remoteRef('system/1111-aaaa'))
  rmSync(join(bare, 'hooks', 'pre-receive'))
  const reconciled = await publisher.reconcile(i)
  assert.equal(reconciled.state, 'applied')
  assert.equal(reconciled.state === 'applied' && reconciled.detail.branchDeleted, 'true')
  assert.throws(() => remoteRef('system/1111-aaaa'))
  const again = await publisher.apply(i)
  assert.equal(again.state, 'applied', again.reason)
  assert.equal(again.detail.branchDeleted, 'true', 'already gone is success')
})

/** A pull request for the System branch that someone opened against another base. */
const foreignPull = (extra: Partial<Pull> = {}): Pull => ({ number: 1, head: 'system/1111-aaaa', base: 'other', draft: false, title: 'by hand', node_id: 'PR_1', ...extra })

test('an open pull request for the branch that targets another base fails, naming both, and is neither merged nor retargeted', async () => {
  for (const params of [merging, {}]) {
    fresh()
    const artifacts = store()
    const { work } = setup()
    pulls.push(foreignPull())
    const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
    const outcome = await publisher.apply(intent(await subjectOf(artifacts, work), params))
    assert.equal(outcome.state, 'failed', outcome.reason)
    assert.match(outcome.reason, /#1/)
    assert.match(outcome.reason, /other/)
    assert.match(outcome.reason, /main/)
    assert.equal(mergeCalls().length, 0)
    assert.equal(pulls.length, 1)
    assert.deepEqual([pulls[0]!.base, pulls[0]!.merged], ['other', undefined])
    assert.equal(calls.filter((c) => !c.startsWith('GET ')).length, 0)
  }
})

test('the pull request body lists the changed tests with the Worker\'s reasons, and says none when there are none', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config())
  const subject = await subjectOf(artifacts, work)
  await publisher.apply({ ...intent(subject), changedTests: [{ path: 'tests/a.test.ts', change: 'modified', reason: 'the message changed' }, { path: 'tests/b.test.ts', change: 'deleted', reason: 'no reason given' }] })
  const body = (pulls[0] as unknown as { body: string }).body
  assert.match(body, /Changed tests/)
  assert.match(body, /- `tests\/a\.test\.ts` \(modified\): the message changed/)
  assert.match(body, /- `tests\/b\.test\.ts` \(deleted\): no reason given/)
  fresh()
  const other = setup('other\n')
  await publisher.apply({ ...intent(await subjectOf(artifacts, other.work)), changedTests: [] })
  assert.match((pulls[0] as unknown as { body: string }).body, /Changed tests: none/)
})

// fl-8: build and cache output is never published, whatever .gitignore says.
function commitFiles(run: (...args: string[]) => string, work: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), text)
  }
  run('add', '-f', '.')
  run('commit', '--quiet', '-m', 'more')
}

test('fl-8: a change adding tools/__pycache__/x.pyc is refused, names the file, publishes nothing and is not a rejection of the base', async () => {
  fresh()
  const artifacts = store()
  const { work, run, remoteRef } = setup()
  commitFiles(run, work, { 'tools/__pycache__/docs.cpython-38.pyc': 'x', 'tools/docs.py': 'ok\n' })
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config())
  const outcome: EffectOutcome & { rejected?: string } = await publisher.apply(intent(await subjectOf(artifacts, work)))
  assert.equal(outcome.state, 'failed')
  assert.equal(outcome.rejected, 'build-output')
  assert.match(outcome.reason, /tools\/__pycache__\/docs\.cpython-38\.pyc/)
  assert.doesNotMatch(outcome.reason, /tools\/docs\.py/)
  assert.equal(outcome.detail.base, undefined)
  assert.equal(pulls.length, 0)
  assert.throws(() => remoteRef('system/1111-aaaa'))
})

test('fl-8: other build and cache output is refused, also when merging', async () => {
  for (const path of ['a.pyc', 'pkg/node_modules/x/index.js', 'docs/.DS_Store']) {
    fresh()
    const artifacts = store()
    const { work, run } = setup()
    commitFiles(run, work, { [path]: 'x' })
    const publisher = githubPublisher(artifacts, { token: async () => undefined }, config({ mergeInto: ['main'] }))
    const outcome: EffectOutcome & { rejected?: string } = await publisher.apply(intent(await subjectOf(artifacts, work), { merge: true }))
    assert.equal(outcome.rejected, 'build-output', path)
    assert.match(outcome.reason, new RegExp(path.replace(/\./g, '\\.')))
  }
})

test('fl-8: a file the base\'s .gitignore ignores is refused; a file the change itself un-ignores is not trusted, a normal change publishes', async () => {
  fresh()
  const artifacts = store()
  const { work, run } = setup()
  writeFileSync(join(work, '.gitignore'), 'dist/\n*.log\n')
  run('add', '.gitignore')
  run('commit', '--quiet', '-m', 'ignore')
  run('push', '--quiet', 'origin', 'main')
  commitFiles(run, work, { 'dist/app.js': 'x', 'src/ok.ts': 'ok\n', 'build.log': 'x' })
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, config())
  const outcome = await publisher.apply(intent(await subjectOf(artifacts, work)))
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.reason, /dist\/app\.js/)
  assert.match(outcome.reason, /build\.log/)
  assert.doesNotMatch(outcome.reason, /src\/ok\.ts/)
  // The same change without the ignored files publishes as before.
  fresh()
  run('reset', '--quiet', '--hard', 'HEAD~1')
  commitFiles(run, work, { 'src/ok.ts': 'ok\n' })
  const ok = await publisher.apply(intent(await subjectOf(artifacts, work), {}, 'work:5555-eeee'))
  assert.equal(ok.state, 'applied', ok.reason)
  assert.equal(pulls.length, 1)
})
