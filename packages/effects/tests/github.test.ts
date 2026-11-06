/**
 * `git.publish` against a real bare git remote (file://) and a fake GitHub
 * REST/GraphQL API recording every call.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { Artifacts } from '@system/artifacts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { GIT_TREE_KIND, gitTreeSchema, pin, snapshot, type EffectIntent } from '@system/work'
import { githubPublisher, type PublishConfig } from '../src/github.ts'

const root = mkdtempSync(join(tmpdir(), 'system-effects-'))
interface Pull { number: number; head: string; base: string; draft: boolean; title: string; node_id: string; merged?: boolean; mergeCommit?: string }
const calls: string[] = []
let pulls: Pull[] = []
let api = ''
let bareOf = ''
/** When set, the merge endpoint answers with this status instead of merging. */
let mergeRefusal: { status: number; message: string } | undefined
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
      const merge = /^\/repos\/tester\/scratch\/pulls\/(\d+)\/merge$/.exec(url.pathname)
      if (req.method === 'PUT' && merge) {
        const pull = pulls.find((p) => p.number === Number(merge[1]))!
        const input = JSON.parse(body) as { sha: string; merge_method: string }
        if (mergeRefusal) return send(mergeRefusal.status, { message: mergeRefusal.message })
        if (pull.merged || pull.draft) return send(405, { message: 'Pull Request is not mergeable' })
        if (input.sha !== headSha(pull.head)) return send(409, { message: 'Head branch was modified. Review and try the merge again.' })
        pull.merged = true
        pull.mergeCommit = execFileSync('git', ['-C', bareOf, 'commit-tree', '-p', input.sha, '-m', 'merge', `${input.sha}^{tree}`], { env, encoding: 'utf8' }).trim()
        return send(200, { sha: pull.mergeCommit, merged: true, message: 'Pull Request successfully merged' })
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
  mergeRefusal = undefined
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

test('merge: true opens a non-draft pull request and merges it with the exact commit as sha', async () => {
  fresh()
  const artifacts = store()
  const { work, remoteRef } = setup()
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
  const outcome = await publisher.apply(intent(await subjectOf(artifacts, work), merging))
  const commit = (await snapshot(work)).commit
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.equal(pulls[0]!.draft, false)
  assert.equal(pulls[0]!.merged, true)
  assert.deepEqual(mergeCalls().map((c) => c.split(' ')[1]), ['/repos/tester/scratch/pulls/1/merge'])
  assert.equal(remoteRef('system/1111-aaaa'), commit)
  assert.equal(outcome.detail.merged, 'true')
  assert.equal(outcome.detail.mergeCommit, pulls[0]!.mergeCommit)
  assert.equal(outcome.detail.draft, 'false')
})

test('merge: true marks a reused draft pull request ready, then merges it', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  const subject = await subjectOf(artifacts, work)
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
  await publisher.apply(intent(subject))
  assert.equal(pulls[0]!.draft, true)
  calls.length = 0
  const outcome = await publisher.apply(intent(subject, merging))
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.deepEqual(calls.map((c) => c.split(' auth')[0]!).filter((c) => /graphql|merge/.test(c)), ['POST /graphql', 'PUT /repos/tester/scratch/pulls/1/merge'])
  assert.equal(pulls.length, 1)
  assert.equal(pulls[0]!.merged, true)
})

test('a pull request already merged at the commit is applied without a second merge call', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  const i = intent(await subjectOf(artifacts, work), merging)
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
  await publisher.apply(i)
  calls.length = 0
  const again = await publisher.apply(i)
  assert.equal(again.state, 'applied', again.reason)
  assert.equal(again.detail.merged, 'true')
  assert.equal(again.detail.mergeCommit, pulls[0]!.mergeCommit)
  assert.equal(mergeCalls().length, 0)
  assert.equal(pulls.length, 1)
})

test('a head that moved (409) or a pull request that is not mergeable (405) fails with GitHub\'s message, never retried', async () => {
  for (const [status, message] of [[409, 'Head branch was modified. Review and try the merge again.'], [405, 'Pull Request is not mergeable']] as const) {
    fresh()
    const artifacts = store()
    const { work } = setup()
    mergeRefusal = { status, message }
    const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
    const outcome = await publisher.apply(intent(await subjectOf(artifacts, work), merging))
    assert.equal(outcome.state, 'failed')
    assert.ok(outcome.reason.includes(message), outcome.reason)
    assert.equal(mergeCalls().length, 1)
    assert.equal(pulls[0]!.merged, undefined)
  }
})

test('another GitHub error while merging still throws, so the controller reconciles', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  mergeRefusal = { status: 502, message: 'bad gateway' }
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
  const i = intent(await subjectOf(artifacts, work), merging)
  await assert.rejects(() => publisher.apply(i), /HTTP 502/)
})

test('reconcile with merge: true is applied only when merged at the commit, absent while open, unknown when unreadable', async () => {
  fresh()
  const artifacts = store()
  const { work, run } = setup()
  const i = intent(await subjectOf(artifacts, work), merging)
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
  assert.equal((await publisher.reconcile(i)).state, 'absent')
  await publisher.apply(intent(i.subject))
  const open = await publisher.reconcile(i)
  assert.equal(open.state, 'absent')
  assert.match(open.reason, /not merged/)
  calls.length = 0
  await publisher.apply(i)
  calls.length = 0
  const merged = await publisher.reconcile(i)
  assert.equal(merged.state, 'applied')
  assert.equal(merged.state === 'applied' && merged.detail.merged, 'true')
  assert.equal(merged.state === 'applied' && merged.detail.mergeCommit, pulls[0]!.mergeCommit)
  assert.equal(calls.filter((c) => !c.startsWith('GET ')).length, 0, 'reconcile only reads')
  // The branch moved on after the merge: the commit is no longer what the branch holds.
  writeFileSync(join(work, 'CHANGE.md'), 'later\n')
  run('commit', '--quiet', '-am', 'later')
  const later = intent(await subjectOf(artifacts, work), merging)
  assert.equal((await publisher.reconcile(later)).state, 'absent')
  const dead = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig({ apiUrl: 'http://127.0.0.1:1' }))
  assert.equal((await dead.reconcile(i)).state, 'unknown')
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

test('a pull request merged into another base is not taken for a merge into the configured one', async () => {
  fresh()
  const artifacts = store()
  const { work } = setup()
  const subject = await subjectOf(artifacts, work)
  const publisher = githubPublisher(artifacts, { token: async () => undefined }, mergeConfig())
  await publisher.apply(intent(subject, merging))
  pulls[0]!.base = 'other'
  const i = intent(subject, merging)
  assert.equal((await publisher.reconcile(i)).state, 'absent')
  calls.length = 0
  const outcome = await publisher.apply(i)
  assert.equal(outcome.state, 'applied', outcome.reason)
  assert.equal(pulls.length, 2)
  assert.equal(pulls[1]!.base, 'main')
  assert.equal(pulls[1]!.merged, true)
})
