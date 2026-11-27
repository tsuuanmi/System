/**
 * The `sandbox` Account option (ADR-0016 decisions 2, 3, 6): one bubblewrap layer around a CLI Runtime's process. The argv it builds is
 * tested as a pure function; the layer itself with a shell script as the agent, through `agentWorker` and a real process.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as http } from 'node:http'
import { createServer as unix } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { processSpawner } from '../../../test-support/process.ts'
import { GIT_TREE_KIND, TASK_KIND, gitTreeSchema, snapshot, taskSchema, type WorkerRequest } from '@system/work'
import type { Workspace } from '../src/workspace.ts'
import { agentWorker, type Account } from '../src/agent.ts'
import { SANDBOX_LAYER_UNAVAILABLE, realHost, sandboxArgv, type SandboxHost } from '../src/adapters/sandbox.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'system-sandbox-'))
after(() => rmSync(root, { recursive: true, force: true }))

const plan = { bwrap: '/usr/bin/bwrap', home: '/home/op', state: '/home/op/.dsh/system', common: { dir: '/srv/repo/.git', hooks: true }, readOnly: ['/home/op/.nvm/versions/node/v24/bin'], readWrite: ['/home/op/.dsh/system/antigravity/a/.gemini'] }
const ws = { root: '/home/op/.dsh/system/attempts/a1', work: '/home/op/.dsh/system/attempts/a1/work' } as Workspace

/** The mount arguments in order: `[flag, source, destination]` (or `[flag, destination]` for `--tmpfs`, `--dev`, `--proc`). */
function mounts(argv: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < argv.indexOf('--'); i++) {
    const arity = ['--ro-bind', '--bind'].includes(argv[i]!) ? 2 : ['--tmpfs', '--dev', '--proc', '--chdir'].includes(argv[i]!) ? 1 : 0
    if (arity) { out.push(argv.slice(i, i + 1 + arity)); i += arity }
  }
  return out
}

test('the layer hides the passwd home and the Host state, binds the attempt and the toolchain, and keeps the network', () => {
  const argv = sandboxArgv(['claude', '-p', 'x'], ws, plan)
  assert.equal(argv[0], '/usr/bin/bwrap')
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['claude', '-p', 'x'])
  const m = mounts(argv)
  const at = (...mount: string[]) => m.findIndex((x) => x.join(' ') === mount.join(' '))
  assert.ok(at('--ro-bind', '/', '/') >= 0)
  assert.ok(at('--dev', '/dev') >= 0 && at('--proc', '/proc') >= 0)
  const home = at('--tmpfs', '/home/op'), state = at('--tmpfs', '/home/op/.dsh/system'), attempt = at('--bind', ws.root, ws.root)
  assert.ok(home > at('--ro-bind', '/', '/'), 'the home is hidden after the root is bound')
  assert.ok(state > home && attempt > state, 'the Host state is hidden, then the attempt is bound back into it')
  assert.ok(at('--ro-bind', '/home/op/.nvm/versions/node/v24/bin', '/home/op/.nvm/versions/node/v24/bin') > home, 'the toolchain is bound read-only after the home is hidden')
  assert.ok(at('--bind', plan.readWrite[0]!, plan.readWrite[0]!) > state, 'what the attempt links to is bound after the state is hidden')
  assert.ok(m.some((x) => x[0] === '--chdir' && x[1] === ws.work))
  assert.equal(argv.some((a) => a === '--unshare-net' || a === '--unshare-all'), false, 'the network is kept')
  assert.ok(argv.includes('--die-with-parent') && argv.includes('--unshare-pid'))
})

test('the repository\'s git data is writable for a commit, but its config and hooks are bound read-only over it', () => {
  const m = mounts(sandboxArgv(['x'], ws, plan))
  const at = (...mount: string[]) => m.findIndex((x) => x.join(' ') === mount.join(' '))
  const rw = at('--bind', '/srv/repo/.git', '/srv/repo/.git')
  assert.ok(rw >= 0)
  assert.ok(at('--ro-bind', '/srv/repo/.git/config', '/srv/repo/.git/config') > rw)
  assert.ok(at('--ro-bind', '/srv/repo/.git/hooks', '/srv/repo/.git/hooks') > rw)
  const noHooks = mounts(sandboxArgv(['x'], ws, { ...plan, common: { dir: '/srv/repo/.git', hooks: false } }))
  assert.ok(noHooks.some((x) => x.join(' ') === '--ro-bind /dev/null /srv/repo/.git/hooks'), 'a repository with no hooks directory gets none created')
  assert.equal(mounts(sandboxArgv(['x'], ws, { ...plan, common: undefined })).some((x) => x[1]?.includes('/srv')), false, 'no repository, no git binds')
})

// ---- through a real process ----

const bwrapOf = realHost().bwrap()
const usable = bwrapOf && spawnSync(bwrapOf, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', 'true']).status === 0
const skip = !usable && 'unprivileged user namespaces are off here (bubblewrap cannot start)'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
const memory = () => memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...GIT_TREE_KIND, content: gitTreeSchema })

/** A fake home with a `.ssh`, a fake DSH_HOME/system with a store and a listening Host socket, a repository, and the probe script; the layer is told the fake home. */
async function setup(host: (home: string) => SandboxHost, sandbox = true, runtime: 'claude-code' | 'antigravity' = 'claude-code') {
  const dir = mkdtempSync(join(root, 'case-'))
  const home = join(dir, 'home'), state = join(dir, 'dsh', 'system'), repository = join(dir, 'repo'), tools = join(dir, 'tools')
  for (const d of [join(home, '.ssh'), state, repository, tools]) mkdirSync(d, { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret')
  writeFileSync(join(state, 'state.sqlite'), 'store')
  const socket = unix()
  const cwd = process.cwd()
  process.chdir(state)
  socket.listen('host.sock')
  process.chdir(cwd)
  await new Promise((resolve) => socket.once('listening', resolve))
  const web = http((_, res) => res.end('ok')).listen(0, '127.0.0.1')
  await new Promise((resolve) => web.once('listening', resolve))
  git(repository, 'init', '--quiet')
  writeFileSync(join(repository, 'README.md'), 'base\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '--quiet', '-m', 'base')
  mkdirSync(join(repository, '.git', 'hooks'), { recursive: true })
  const command = join(tools, 'agent.sh')
  copyFileSync(join(here, runtime === 'antigravity' ? 'fake-sandbox-agy.sh' : 'fake-sandbox-agent.sh'), command)
  execFileSync('chmod', ['+x', command])
  writeFileSync(join(tools, 'probe.conf'), `HOME_DIR=${home}\nSTATE=${state}\nCOMMON=${join(repository, '.git')}\nPORT=${(web.address() as { port: number }).port}\n`)
  const artifacts = memory().artifacts
  const producer = { type: 'operator' as const, ref: 'tester' }
  const base = (await artifacts.put({ ...GIT_TREE_KIND, content: await snapshot(repository), classification: 'local-private', producer })).id
  const input = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'probe', base }, inputs: [base], classification: 'local-private', producer })).id
  const agyHome = join(dir, 'agy')
  mkdirSync(join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true })
  writeFileSync(join(agyHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'tok\n')
  const account: Account = { ref: `${runtime}/default`, runtime, ...(runtime === 'antigravity' ? { agyHome } : {}), capabilities: ['repo.write'], command, version: async () => 'fake', token: async () => 't', ...(sandbox ? { sandbox: true as const } : {}) }
  const request: WorkerRequest = { workId: 'work:t', attemptId: `attempt:${Math.random().toString(16).slice(2)}`, stepId: 'implement', capabilities: ['repo.write'], inputs: { task: input }, outputs: ['change'], signal: new AbortController().signal }
  const attempts = join(state, 'attempts')
  const worker = agentWorker(account, artifacts, processSpawner, attempts, undefined, undefined, host(home))
  return { worker, request, repository, close: () => { socket.close(); web.close() }, home, state }
}

test('a Worker in the layer cannot read the Host store, reach its socket, list ~/.ssh or write hooks and config; it commits, runs node --test and reaches the network', { skip }, async () => {
  const s = await setup((home) => ({ ...realHost(), home: () => home }))
  try {
    const result = await s.worker.run(s.request)
    assert.equal(result.status, 'succeeded', result.reason)
    assert.equal(result.message, 'state=denied;socket=denied;ssh=denied;home=empty;hooks=denied;config=denied;commit=ok;nodetest=ok;network=open;')
    assert.equal((result.executor!.scope as { sandbox: unknown }).sandbox, true, 'the attempt records that the layer was on')
    assert.equal(execFileSync('git', ['-C', s.repository, 'config', '--get', 'core.bare'], { encoding: 'utf8' }).trim(), 'false', 'the config is as it was')
  } finally { s.close() }
})


test('the same probe without the option sees and does it all: the layer is what hides it', { skip }, async () => {
  const s = await setup((home) => ({ ...realHost(), home: () => home }), false)
  try {
    const result = await s.worker.run(s.request)
    assert.equal(result.status, 'succeeded', result.reason)
    assert.equal(result.message, 'state=read;socket=connected;ssh=listed;home=listed;hooks=written;config=written;commit=ok;nodetest=ok;network=open;')
    assert.equal((result.executor!.scope as { sandbox: unknown }).sandbox, false)
  } finally { s.close() }
})

test('with bwrap not found the attempt fails as an Outside failure and the agent never ran', async () => {
  const s = await setup((home) => ({ ...realHost('/nonexistent'), home: () => home }))
  try {
    const result = await s.worker.run(s.request)
    assert.equal(result.status, 'failed')
    assert.match(result.reason!, new RegExp(SANDBOX_LAYER_UNAVAILABLE))
    assert.equal(result.cause, 'load')
    assert.equal(result.usage, undefined, 'the agent printed nothing')
  } finally { s.close() }
})

test('an Antigravity attempt in the layer runs the repository Node first on PATH and cannot list the passwd home .ssh', { skip }, async () => {
  const s = await setup((home) => ({ ...realHost(), home: () => home }), true, 'antigravity')
  try {
    const result = await s.worker.run(s.request)
    assert.equal(result.status, 'succeeded', result.reason)
    const [, version, ssh] = /^node=(v[\d.]+);ssh=(\w+);$/.exec(result.message!.trim()) ?? []
    const satisfies = (v: string) => { const [a = 0, b = 0] = v.slice(1).split('.').map(Number), [x, y] = [24, 9]; return a > x || (a === x && b >= y) }
    assert.ok(version && satisfies(version), `node -v printed ${version} (engines.node >=24.9.0)`)
    assert.equal(ssh, 'denied')
    assert.equal((result.executor!.scope as { sandbox: unknown }).sandbox, 'bubblewrap')
  } finally { s.close() }
})
