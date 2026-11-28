/** A caller's view of `dev` is fresh: `task.new` and `status` fetch `origin dev` (temporary repositories with a bare origin). */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Artifacts } from '@system/artifacts'
import { memoryBlobStore, memoryRecordTable } from '../../../test-support/memory.ts'
import { readStatus } from '../src/gate.ts'
import { WorkService } from '../src/index.ts'
import { GIT_TREE_KIND, TASK_KIND, gitTreeSchema, taskSchema } from '../src/kinds.ts'

const caller = { type: 'human', operatorId: 'tan' } as const
const STATUS_V1 = 'Aim: x\n- [ ] a-1 First\n'
const STATUS_V2 = 'Aim: x\n- [ ] a-1 First\n- [ ] a-2 Second\n'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { stdio: 'pipe' }).toString().trim()

/** A bare origin with `dev`, a clone `local` of it, and a second clone `other` that can push to it. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'system-fresh-')))
  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'dev', origin])
  const seed = join(root, 'seed')
  execFileSync('git', ['init', '-q', '-b', 'dev', seed])
  writeFileSync(join(seed, 'STATUS.md'), STATUS_V1)
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'one')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'dev')
  const local = join(root, 'local')
  const other = join(root, 'other')
  execFileSync('git', ['clone', '-q', '-b', 'dev', origin, local])
  execFileSync('git', ['clone', '-q', '-b', 'dev', origin, other])
  /** A commit lands on the origin (pushed from `other`); returns its ID. */
  const land = (text = STATUS_V2) => {
    writeFileSync(join(other, 'STATUS.md'), text)
    git(other, 'commit', '-qam', 'two')
    git(other, 'push', '-q', 'origin', 'dev')
    return git(other, 'rev-parse', 'HEAD')
  }
  return { root, origin, local, land, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function service() {
  const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
  artifacts.registerKind({ ...TASK_KIND, content: taskSchema })
  artifacts.registerKind({ ...GIT_TREE_KIND, content: gitTreeSchema })
  return new WorkService(undefined as never, artifacts, undefined as never)
}

test('task.new with dev behind origin/dev is refused, naming both commits; equal, it is admitted', async () => {
  const s = setup()
  try {
    const stale = git(s.local, 'rev-parse', 'dev')
    const landed = s.land()
    // The local origin/dev still says `stale`: only a fetch shows the commit.
    await assert.rejects(service().newTask('x', s.local, 'dev', caller), (e: Error) => {
      assert.ok(e.message.includes(stale.slice(0, 12)), e.message)
      assert.ok(e.message.includes(landed.slice(0, 12)), e.message)
      assert.match(e.message, /origin\/dev/)
      return true
    })
    // A commit is taken as given.
    assert.equal((await service().newTask('x', s.local, stale, caller)).note, undefined)
    git(s.local, 'merge', '-q', '--ff-only', 'origin/dev')
    const equal = await service().newTask('x', s.local, 'dev', caller)
    assert.ok(equal.task)
    assert.equal(equal.note, undefined)
  } finally { s.cleanup() }
})

test('task.new goes on when the fetch fails, and says so in its result', async () => {
  const s = setup()
  try {
    git(s.local, 'remote', 'set-url', 'origin', join(s.root, 'missing.git'))
    const made = await service().newTask('x', s.local, 'dev', caller)
    assert.ok(made.task)
    assert.match(made.note!, /fetch of origin dev failed/)
  } finally { s.cleanup() }
})

test('task.new in a repository with no origin is as before', async () => {
  const s = setup()
  try {
    git(s.local, 'remote', 'remove', 'origin')
    const made = await service().newTask('x', s.local, 'dev', caller)
    assert.equal(made.note, undefined)
  } finally { s.cleanup() }
})

test('status shows a commit that landed on the origin after the fetch, and fetches again only when the last fetch is old', async () => {
  const s = setup()
  try {
    s.land()
    const first = await readStatus(s.local)
    assert.deepEqual(first.items.map((i) => i.id), ['a-1', 'a-2'])
    assert.match(first.note, /^read origin\/dev \(.*fetched/)
    assert.doesNotMatch(first.note, /not fetched/)

    const landed = s.land(`${STATUS_V2}- [ ] a-3 Third\n`)
    const recent = await readStatus(s.local)
    assert.deepEqual(recent.items.map((i) => i.id), ['a-1', 'a-2'], 'a fetch a moment ago is not repeated')
    const old = await readStatus(s.local, { fetchAfterMs: 0 })
    assert.equal(old.commit, landed)
    assert.deepEqual(old.items.map((i) => i.id), ['a-1', 'a-2', 'a-3'])
  } finally { s.cleanup() }
})

test('status whose fetch fails reads the ref it has and says the fetch failed', async () => {
  const s = setup()
  try {
    git(s.local, 'remote', 'set-url', 'origin', join(s.root, 'missing.git'))
    const read = await readStatus(s.local)
    assert.equal(read.ref, 'origin/dev')
    assert.match(read.note, /^read origin\/dev \(.*fetch failed/)
  } finally { s.cleanup() }
})

test('the DNA incident: dev 22 commits behind origin/dev is refused by task.new, and status and task.new (origin/dev) read the same commit', async () => {
  const s = setup()
  try {
    const stale = git(s.local, 'rev-parse', 'dev')
    let tip = ''
    for (let n = 0; n < 22; n++) tip = s.land(`${STATUS_V2}- [ ] c-${n} Commit ${n}\n`)
    await assert.rejects(service().newTask('x', s.local, 'dev', caller), (e: Error) => e.message.includes(stale.slice(0, 12)) && e.message.includes(tip.slice(0, 12)) && /use origin\/dev/.test(e.message))
    const status = await readStatus(s.local, { fetchAfterMs: 0 })
    const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
    artifacts.registerKind({ ...TASK_KIND, content: taskSchema })
    artifacts.registerKind({ ...GIT_TREE_KIND, content: gitTreeSchema })
    const made = await new WorkService(undefined as never, artifacts, undefined as never).newTask('x', s.local, 'origin/dev', caller)
    const got = artifacts.get(made.base!)
    assert.equal(got.state, 'stored')
    const base = (got as { envelope: { content: unknown } }).envelope.content as { commit: string }
    assert.equal(status.commit, tip)
    assert.equal(base.commit, status.commit)
  } finally { s.cleanup() }
})

test('b684f18 broke `system update`: status\'s fetch must reach the same origin as the afterInstall `git fetch origin dev:refs/remotes/origin/dev` (ssh settings kept), which then still succeeds', async () => {
  const s = setup()
  const standIn = join(s.root, 'ssh.sh')
  // A stand-in for ssh as tools/upgrade-rehearsal.mjs has it: `git@github.com:...` reaches the local bare origin.
  writeFileSync(standIn, `#!/bin/sh\ncmd=$(printf '%s' "$2" | sed "s|'[^']*'|'${s.origin}'|")\nexec /bin/sh -c "$cmd"\n`, { mode: 0o755 })
  const saved = { ssh: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT }
  try {
    git(s.local, 'remote', 'set-url', 'origin', 'git@github.com:tsuuanmi/System.git')
    git(s.local, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main') // an install repository fetches only main
    process.env.GIT_SSH_COMMAND = standIn
    process.env.GIT_SSH_VARIANT = 'simple'
    const landed = s.land()
    const read = await readStatus(s.local, { fetchAfterMs: 0, fetchTimeoutMs: 5000 })
    assert.equal(read.commit, landed, read.note)
    git(s.local, 'fetch', '-q', 'origin', 'dev:refs/remotes/origin/dev') // not forced: it must not find origin/dev diverged
    assert.equal(git(s.local, 'rev-parse', 'origin/dev'), landed)
  } finally {
    for (const [key, value] of [['GIT_SSH_COMMAND', saved.ssh], ['GIT_SSH_VARIANT', saved.variant]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    s.cleanup()
  }
})

test('task.new with origin/dev reads the origin, not the clone\'s stale refs/remotes/origin/dev', async () => {
  const s = setup()
  try {
    const landed = s.land()
    const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
    artifacts.registerKind({ ...TASK_KIND, content: taskSchema })
    artifacts.registerKind({ ...GIT_TREE_KIND, content: gitTreeSchema })
    const made = await new WorkService(undefined as never, artifacts, undefined as never).newTask('x', s.local, 'origin/dev', caller)
    assert.equal(made.note, undefined)
    const got = artifacts.get(made.base!) as { envelope: { content: { commit: string } } }
    assert.equal(got.envelope.content.commit, landed)
    assert.equal(git(s.local, 'rev-parse', 'refs/remotes/origin/dev'), landed)
  } finally { s.cleanup() }
})

test('task.new with origin/dev goes on with a note when the fetch fails', async () => {
  const s = setup()
  try {
    git(s.local, 'remote', 'set-url', 'origin', join(s.root, 'missing.git'))
    const made = await service().newTask('x', s.local, 'origin/dev', caller)
    assert.ok(made.base)
    assert.match(made.note ?? '', /fetch of origin dev failed/)
  } finally { s.cleanup() }
})
