/** Item rb-2: tools/hooks/pre-push refuses a push to dev while a fast check fails, and ignores other refs. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

const hook = resolve('tools/hooks/pre-push')
let root: string
let repo: string
let env: NodeJS.ProcessEnv

const sh = (cwd: string, cmd: string, args: string[], e = env) => spawnSync(cmd, args, { cwd, env: e, encoding: 'utf8' })

before(() => {
  root = mkdtempSync(join(tmpdir(), 'pre-push-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // Stand-ins for the four checks; FAIL names the one that fails.
  for (const name of ['python3', 'node', 'corepack']) {
    writeFileSync(join(bin, name), `#!/bin/sh\ncase "$*" in *"$FAIL"*) [ -n "$FAIL" ] && exit 1;; esac\nexit 0\n`)
    chmodSync(join(bin, name), 0o755)
  }
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  const remote = join(root, 'remote.git')
  repo = join(root, 'repo')
  mkdirSync(repo)
  sh(root, 'git', ['init', '--quiet', '--bare', remote])
  sh(repo, 'git', ['init', '--quiet', '-b', 'main'])
  sh(repo, 'git', ['remote', 'add', 'origin', remote])
  sh(repo, 'git', ['config', 'core.hooksPath', dirname(hook)])
  sh(repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'c'])
})
after(() => rmSync(root, { recursive: true, force: true }))

const push = (ref: string, fail = '', extra: string[] = []) => sh(repo, 'git', ['push', ...extra, 'origin', `HEAD:refs/heads/${ref}`], { ...env, FAIL: fail })

test('a push to dev with a failing check is refused, naming the check', () => {
  const r = push('dev', 'typecheck')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /refusing the push to dev: 'corepack pnpm typecheck' failed/)
  assert.match(r.stderr, /--no-verify/)
  assert.notEqual(sh(repo, 'git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/dev']).status, 0)
})

test('a push to dev passes when the checks pass', () => {
  assert.equal(push('dev').status, 0)
})

test('a push to another ref passes even when a check fails', () => {
  assert.equal(push('topic', 'test').status, 0)
})

test('--no-verify bypasses the hook', () => {
  assert.equal(push('dev', 'test', ['--no-verify', '--force']).status, 0)
})
