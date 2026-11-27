/**
 * iso-3 (ADR-0016 decision 5): the scheduled session's `claude -p` runs inside a bubblewrap layer with only the caller socket.
 * The real launcher and a real Host; `claude` is a fake script that reports what it can see from inside.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { repo, systemCli } from '../test-support/cli.ts'

const launcher = join(repo, 'packages', 'bundle', 'system-night-session.sh')
const cli = systemCli('system-layer', { SYSTEM_OPERATOR_ID: 'night' })
const home = cli.home
const tools = mkdtempSync(join(home, 'tools-'))
const night = mkdtempSync(join(home, 'repo-'))
const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', 'true'], { stdio: 'ignore' })
const skip = probe.status === 0 ? false : 'bubblewrap cannot start here (no bwrap, or unprivileged user namespaces are off)'

const exe = (name: string, body: string) => {
  writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(tools, name), 0o755)
}

before(async () => {
  assert.equal(cli.run(['init']).status, 0)
  spawnSync('git', ['init', '-q', night])
  await cli.start()
  exe('system', `exec "${process.execPath}" "${join(repo, 'bin', 'system')}" "$@"`)
  // The fake claude says what it sees from inside; its answer is the night report.
  exe('claude', `echo ran > "${tools}/claude.ran"
if system work list >/dev/null 2>&1; then echo "caller: answers"; else echo "caller: refused"; fi
for p in "${join(home, 'system', 'operator', 'host.sock')}" "${join(home, 'system', 'operator')}" "${join(home, 'system', 'state.sqlite')}" "${userInfo().homedir}/.ssh"; do
  if [ -e "$p" ]; then echo "visible: $p"; else echo "absent: $p"; fi
done
if touch "${night}/planted" 2>/dev/null; then echo "repo: writable"; else echo "repo: read-only"; fi
if touch "$TMPDIR/ok" 2>/dev/null; then echo "tmp: writable"; else echo "tmp: read-only"; fi`)
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

function night_(path: string) {
  const res = spawnSync('sh', [launcher], { env: { ...cli.env, PATH: path, SYSTEM_NIGHT_REPOS: night } as NodeJS.ProcessEnv, encoding: 'utf8', cwd: home })
  const id = res.stdout.trim().split('\n').at(-1)!
  const report = cli.run(['artifact', 'cat', id])
  return { res, report: report.stdout }
}

test('inside the layer the caller socket answers, the Operator\'s files are not there, the repository is read-only', { skip }, () => {
  const { res, report } = night_(`${tools}:${process.env.PATH}`)
  assert.equal(res.status, 0, res.stderr)
  assert.match(report, /^caller: answers$/m)
  assert.match(report, new RegExp(`^absent: ${join(home, 'system', 'operator', 'host.sock')}$`, 'm'))
  assert.match(report, new RegExp(`^absent: ${join(home, 'system', 'operator')}$`, 'm'))
  assert.match(report, new RegExp(`^absent: ${join(home, 'system', 'state.sqlite')}$`, 'm'))
  assert.match(report, new RegExp(`^absent: ${userInfo().homedir}/.ssh$`, 'm'))
  assert.doesNotMatch(report, /^visible:/m)
  assert.match(report, /^repo: read-only$/m)
  assert.match(report, /^tmp: writable$/m)
  assert.equal(existsSync(join(night, 'planted')), false)
})

test('without bwrap the fake claude never runs and the report says the layer could not start', () => {
  // A PATH with the fakes and the tools the launcher needs (git, node, sh...), but no bwrap.
  const bare = mkdtempSync(join(home, 'nobwrap-'))
  for (const name of ['sh', 'git', 'mktemp', 'rm', 'cat', 'grep', 'date', 'mv', 'printf', 'dirname', 'timeout', 'realpath', 'readlink', 'getent', 'id', 'env']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
    if (found.startsWith('/')) spawnSync('ln', ['-s', found, join(bare, name)])
  }
  const { res, report } = night_(`${tools}:${bare}:${join(process.execPath, '..')}`)

  assert.notEqual(res.status, 0)
  assert.equal(existsSync(join(tools, 'claude.ran')), false, 'claude never ran')
  assert.match(report, /layer could not start/i)
  assert.doesNotMatch(report, /^caller:/m)
})

test('with a bwrap that cannot start a namespace the fake claude never runs and the report says the layer could not start', () => {
  const broken = mkdtempSync(join(home, 'brokenbwrap-'))
  writeFileSync(join(broken, 'bwrap'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(broken, 'bwrap'), 0o755)
  const { res, report } = night_(`${broken}:${tools}:${process.env.PATH}`)

  assert.notEqual(res.status, 0)
  assert.equal(existsSync(join(tools, 'claude.ran')), false, 'claude never ran')
  assert.match(report, /cannot create a user namespace/i)
  assert.doesNotMatch(report, /^caller:/m)
})
