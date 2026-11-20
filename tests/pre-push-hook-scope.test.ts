/** Escaped defect 01d80c6a (against rb-2): the pre-push hook must never change the operator's repository. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

let root: string
let main: string
let tree: string
let remote: string
let env: NodeJS.ProcessEnv

const run = (cwd: string, cmd: string, args: string[], e: NodeJS.ProcessEnv = env, input?: string) => spawnSync(cmd, args, { cwd, env: e, input, encoding: 'utf8' })
const git = (cwd: string, ...args: string[]) => run(cwd, 'git', args)
const stub = (dir: string, name: string, body: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}
const bare = (cwd: string) => git(cwd, 'config', '--bool', '--get', 'core.bare').stdout.trim()

before(() => {
  root = mkdtempSync(join(tmpdir(), 'pre-push-scope-'))
  // A copy of the hook and its Node finder, so core.hooksPath can point at the copy.
  mkdirSync(join(root, 'tools', 'hooks'), { recursive: true })
  copyFileSync(resolve('tools/hooks/pre-push'), join(root, 'tools', 'hooks', 'pre-push'))
  chmodSync(join(root, 'tools', 'hooks', 'pre-push'), 0o755)
  copyFileSync(resolve('tools/node-bin.ts'), join(root, 'tools', 'node-bin.ts'))
  symlinkSync(resolve('packages'), join(root, 'packages')) // what node-bin.ts imports
  const bin = join(root, 'bin')
  stub(bin, 'python3', 'exit 0')
  stub(bin, 'node', `case "$1" in *node-bin.ts) exec "${process.execPath}" "$@";; esac\nexit 1`)
  const home = join(root, 'home')
  const nodeDir = join(home, '.nvm', 'versions', 'node', 'v99.0.0', 'bin')
  stub(nodeDir, 'node', 'exit 0')
  // `pnpm test` is the test command; here it runs `git init --bare` in a scratch directory with the inherited environment, as a test did.
  stub(nodeDir, 'corepack', `case "$*" in *test*) echo ran >> "${join(root, 'test-ran')}"; mkdir -p "${join(root, 'scratch.git')}"; (cd "${join(root, 'scratch.git')}" && git init --quiet --bare);; esac\nexit 0`)
  env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !key.startsWith('GIT_CONFIG_')) delete env[key]
  remote = join(root, 'remote.git')
  main = join(root, 'main')
  tree = join(root, 'tree')
  mkdirSync(main)
  git(root, 'init', '--quiet', '--bare', remote)
  writeFileSync(join(main, 'package.json'), JSON.stringify({ engines: { node: '>=99' } }))
  git(main, 'init', '--quiet', '-b', 'main')
  git(main, 'remote', 'add', 'origin', remote)
  git(main, 'config', 'core.hooksPath', join(root, 'tools', 'hooks'))
  git(main, 'add', 'package.json')
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'c')
  git(main, 'branch', 'dev')
  git(main, 'worktree', 'add', '--quiet', '-b', 'attempt', tree)
})
after(() => rmSync(root, { recursive: true, force: true }))

const ran = () => { try { return readFileSync(join(root, 'test-ran'), 'utf8').length > 0 } catch { return false } }
const reset = () => { rmSync(join(root, 'test-ran'), { force: true }); rmSync(join(root, 'scratch.git'), { recursive: true, force: true }) }

test('a push of dev from a linked worktree to a local bare repository leaves the main repository non-bare', () => {
  reset()
  const r = git(tree, 'push', '--force', remote, 'HEAD:refs/heads/dev')
  assert.equal(r.status, 0, r.stderr)
  assert.notEqual(bare(main), 'true')
  assert.equal(git(main, 'rev-parse', '--is-bare-repository').stdout.trim(), 'false')
})

test('the hook scrubs inherited GIT_* variables before a check runs (a real origin)', () => {
  reset()
  const gitDir = git(tree, 'rev-parse', '--absolute-git-dir').stdout.trim()
  const r = run(tree, join(root, 'tools', 'hooks', 'pre-push'), ['origin', 'git@github.com:o/r.git'], { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: tree, GIT_INDEX_FILE: join(gitDir, 'index'), GIT_PREFIX: '' }, 'refs/heads/dev abc refs/heads/dev def\n')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(ran(), true, 'the checks run for the real origin')
  assert.notEqual(bare(main), 'true')
  assert.equal(bare(tree), 'false')
})

test('the hook does nothing for another remote name or a path or file URL', () => {
  const line = 'refs/heads/dev abc refs/heads/dev def\n'
  const hook = join(root, 'tools', 'hooks', 'pre-push')
  for (const args of [['upstream', 'git@github.com:o/r.git'], ['origin', remote], ['origin', `file://${remote}`], ['origin', '../remote.git']]) {
    reset()
    const r = run(tree, hook, args, env, line)
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`)
    assert.equal(ran(), false, `${args.join(' ')} ran a check`)
  }
})

test('the upgrade rehearsal pushes with hooks off', () => {
  const source = readFileSync(resolve('tools/upgrade-rehearsal.mjs'), 'utf8')
  const pushes = source.split('\n').filter((line) => /git\('push'|'push'/.test(line))
  assert.ok(pushes.length >= 2)
  for (const line of pushes) assert.match(line, /core\.hooksPath=\/dev\/null|--no-verify/, line)
})
