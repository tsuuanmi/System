/**
 * The `sandbox` Account option (ADR-0016 decisions 2, 3, 6): one bubblewrap layer around a CLI Runtime's process. The argv it builds is
 * tested as a pure function; the layer itself with a shell script as the agent, through `agentWorker` and a real process.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as http } from 'node:http'
import { createServer as unix } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { layerSkip } from '../../../test-support/layer-gate.ts'
import { processSpawner } from '../../../test-support/process.ts'
import { GIT_TREE_KIND, TASK_KIND, gitTreeSchema, snapshot, taskSchema, type WorkerRequest } from '@system/work'
import type { Workspace } from '../src/workspace.ts'
import { agentWorker, type Account } from '../src/agent.ts'
import { SANDBOX_LAYER_UNAVAILABLE, realHost, sandboxArgv, sandboxed, type SandboxHost } from '../src/adapters/sandbox.ts'

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
const skip = layerSkip(bwrapOf, 'unprivileged user namespaces are off here (bubblewrap cannot start)')

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

// ---- what the layer binds from the hidden home (ADR-0016 decision 2; iso-6) ----

/** An operator-like home, a throwaway attempt root and the layer `sandboxed` builds for it (no repository), as the Worker does. */
function operator(path: (home: string) => string[], build?: (home: string, attempt: string) => void, bwrap: string | undefined = bwrapOf) {
  const dir = mkdtempSync(join(root, 'op-'))
  const home = join(dir, 'home'), state = join(dir, 'dsh', 'system'), attempt = join(state, 'attempts', 'a1')
  const ws = { root: attempt, work: join(attempt, 'work'), home: join(attempt, 'home') } as Workspace
  for (const d of [home, state, ws.work, ws.home]) mkdirSync(d, { recursive: true })
  build?.(home, attempt)
  const PATH = [...path(home), ...(process.env.PATH ?? '').split(':')].join(':')
  const host: SandboxHost = { home: () => home, bwrap: () => bwrap, works: () => true, gitCommonDir: () => undefined }
  const plan = (command = '/bin/sh') => sandboxed(['/bin/sh', '-c', ''], ws, { state, command, env: { PATH } }, host) as { argv: string[] }
  const run = (script: string, command = '/bin/sh') => {
    const { argv } = plan(command)
    argv[argv.length - 1] = script
    return spawnSync(argv[0]!, argv.slice(1), { env: { PATH, HOME: ws.home }, encoding: 'utf8' })
  }
  return { home, state, ws, PATH, plan, run }
}
const file = (path: string, text = 'x', mode?: number) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, mode ? { mode } : undefined) }
const readOnly = (argv: string[]) => mounts(argv).filter((m) => m[0] === '--ro-bind').map((m) => m[1]!)

test('a PATH entry is bound as it is, never its parent: ~/.local/share and ~/.cargo stay hidden, and a script in ~/.local/bin runs', { skip }, () => {
  const o = operator((h) => [join(h, '.local', 'bin'), join(h, '.cargo', 'bin'), join(h, 'go', 'bin')], (h) => {
    file(join(h, '.local', 'bin', 'hello'), '#!/bin/sh\necho hi\n', 0o755)
    file(join(h, '.local', 'share', 'keyrings', 'x'))
    file(join(h, '.cargo', 'bin', 'cargo'), '#!/bin/sh\n', 0o755)
    file(join(h, '.cargo', 'credentials.toml'), 'token')
    file(join(h, 'go', 'bin', 'gopls'), '#!/bin/sh\n', 0o755)
    file(join(h, 'go', 'pkg', 'x'))
  })
  const r = o.run(`hello; for p in .local/share/keyrings/x .cargo/credentials.toml go/pkg/x; do [ -e ${o.home}/$p ] && echo SEEN $p; done; ls ${o.home}/.local ${o.home}/.cargo ${o.home}/go`)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^hi$/m)
  assert.doesNotMatch(r.stdout, /SEEN/)
  assert.equal(/credentials|keyrings|share|pkg/.test(r.stdout), false, r.stdout)
})

test('a launcher that is a link out of its PATH entry runs through the real path\'s directory only', { skip }, () => {
  const o = operator((h) => [join(h, '.local', 'bin')], (h) => {
    file(join(h, '.local', 'share', 'tool', 'versions', '1', 'tool'), '#!/bin/sh\necho tool-ran\n', 0o755)
    file(join(h, '.local', 'share', 'other', 'y'))
    mkdirSync(join(h, '.local', 'bin'), { recursive: true })
    symlinkSync(join(h, '.local', 'share', 'tool', 'versions', '1', 'tool'), join(h, '.local', 'bin', 'tool'))
  })
  const r = o.run(`tool; [ -e ${o.home}/.local/share/other ] && echo SEEN-other`)
  assert.match(r.stdout, /tool-ran/, r.stderr)
  assert.doesNotMatch(r.stdout, /SEEN/)
})

test('the Runtime\'s binary, a link into the home, runs by its real directory and binds no more', { skip }, () => {
  let command = ''
  const o = operator(() => [], (h) => {
    file(join(h, '.local', 'share', 'claude', 'versions', '2', 'claude'), '#!/bin/sh\necho claude-ran\n', 0o755)
    file(join(h, '.local', 'share', 'keyrings', 'x'))
    command = join(h, '.local', 'bin', 'claude')
    mkdirSync(dirname(command), { recursive: true })
    symlinkSync(join(h, '.local', 'share', 'claude', 'versions', '2', 'claude'), command)
  })
  const r = o.run(`${command}; [ -e ${o.home}/.local/share/keyrings ] && echo SEEN`, command)
  assert.match(r.stdout, /claude-ran/, r.stderr)
  assert.doesNotMatch(r.stdout, /SEEN/)
})

test('an nvm binary that is a link into ../lib/node_modules runs: the lib beside bin is bound because the entry links into it', { skip }, () => {
  const o = operator((h) => [join(h, '.nvm', 'versions', 'node', 'v1', 'bin')], (h) => {
    const v = join(h, '.nvm', 'versions', 'node', 'v1')
    file(join(v, 'lib', 'node_modules', 'x', 'cli.js'), '#!/bin/sh\necho cli-ran\n', 0o755)
    file(join(v, 'include', 'node.h'))
    file(join(h, '.nvm', 'alias', 'default'))
    mkdirSync(join(v, 'bin'), { recursive: true })
    symlinkSync('../lib/node_modules/x/cli.js', join(v, 'bin', 'x'))
  })
  const r = o.run(`x; [ -e ${o.home}/.nvm/alias/default ] && echo SEEN-alias; [ -e ${o.home}/.nvm/versions/node/v1/include ] && echo SEEN-include`)
  assert.match(r.stdout, /cli-ran/, r.stderr)
  assert.doesNotMatch(r.stdout, /SEEN/)
})

test('a shebang interpreter under the home is bound by its real directory', { skip }, () => {
  const o = operator((h) => [join(h, '.tools', 'bin')], (h) => {
    file(join(h, '.tools', 'interp', 'run'), '#!/bin/sh\nshift\necho interp-ran\n', 0o755)
    file(join(h, '.tools', 'secret'))
    file(join(h, '.tools', 'bin', 'script'), `#!${join(h, '.tools', 'interp', 'run')}\n`, 0o755)
  })
  const r = o.run(`script; [ -e ${o.home}/.tools/secret ] && echo SEEN`)
  assert.match(r.stdout, /interp-ran/, r.stderr)
  assert.doesNotMatch(r.stdout, /SEEN/)
})

test('a link at <attemptHome>/.gemini/antigravity-cli to an Account file is readable and writable in the layer, and the write reaches the Account file', { skip }, () => {
  let account = ''
  const o = operator(() => [], (_h, attempt) => {
    const state = join(attempt, '..', '..')
    account = join(state, 'antigravity', 'a', 'antigravity-oauth-token')
    file(account, 'tok\n')
    mkdirSync(join(attempt, 'home', '.gemini', 'antigravity-cli'), { recursive: true })
    symlinkSync(account, join(attempt, 'home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
  })
  const link = join(o.ws.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  const r = o.run(`cat ${link} && echo refreshed > ${link} && cat ${link}`)
  assert.match(r.stdout, /^tok\nrefreshed$/m, r.stderr)
  assert.equal(readFileSync(account, 'utf8'), 'refreshed\n')
})

test('the plan for an operator-like PATH binds each entry and no parent the rule did not require', () => {
  const o = operator((h) => ['.nvm/versions/node/v1/bin', '.local/bin', '.cargo/bin', 'go/bin', '.sdkman/candidates/java/current/bin'].map((p) => join(h, p)), (h) => {
    const v = join(h, '.nvm', 'versions', 'node', 'v1')
    file(join(v, 'bin', 'node'), '\x7fELF', 0o755)
    file(join(v, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(v, 'bin', 'npm'))
    file(join(h, '.local', 'bin', 'a'), '#!/bin/sh\n', 0o755)
    file(join(h, '.cargo', 'bin', 'cargo'), '\x7fELF', 0o755)
    file(join(h, 'go', 'bin', 'gopls'), '\x7fELF', 0o755)
    file(join(h, '.sdkman', 'candidates', 'java', '17', 'bin', 'java'), '\x7fELF $ORIGIN/../lib', 0o755)
    file(join(h, '.sdkman', 'candidates', 'java', '17', 'lib', 'libjli.so'))
    symlinkSync(join(h, '.sdkman', 'candidates', 'java', '17'), join(h, '.sdkman', 'candidates', 'java', 'current'))
  }, '/usr/bin/bwrap') // a pure plan: nothing runs, so it needs no bubblewrap that starts (iso-7)
  const bound = readOnly(o.plan().argv).filter((p) => p.startsWith(o.home))
  const expected = ['.nvm/versions/node/v1/bin', '.nvm/versions/node/v1/lib', '.local/bin', '.cargo/bin', 'go/bin', '.sdkman/candidates/java/current/bin', '.sdkman/candidates/java/17/bin', '.sdkman/candidates/java/17/lib'].map((p) => join(o.home, p))
  for (const p of expected) assert.ok(bound.includes(p), `${p} is bound`)
  for (const p of bound) assert.ok(expected.includes(p), `${p} is not required by the rule`)
})
