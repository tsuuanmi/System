/**
 * Item upd-1: `system update` killed while it waits for the Host to drain leaves a pending install check, and the Host that starts
 * on the new release completes it: submits the install-check Work, and on a failed Verdict switches `current` back (the Host then
 * upgrades to the release before). Real Hosts and the real `update()` (test-support/update-driver.mjs answers only the steps that
 * need the network or a build). The old Host is not held by a running attempt here: the kill comes right after the switch.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { copyRelease, repo, systemCli } from '../test-support/cli.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim()
const until = async (what: string, ok: () => boolean, ms = 90_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function scenario(afterInstall: string, check: (s: { base: string; stderr: () => string; c1: string; c2: string; link: () => string | undefined }) => Promise<void>) {
  const base = mkdtempSync('/tmp/sm-pic-')
  const home = join(base, 'home')
  const current = join(base, 'current')
  const cli = systemCli('pic', { HOME: home, SYSTEM_OPERATOR_ID: 'tester', SYSTEM_NO_SERVICE: '1', SYSTEM_INSTALL: base, SYSTEM_UPGRADE_POLL_MS: '100' }, join(home, '.dsh'), join(current, 'bin', 'system'))
  delete cli.env.SYSTEM_CODE
  try {
    const source = join(base, 'src')
    mkdirSync(source)
    git(source, 'init', '-q')
    const commit = (n: number, after: string) => {
      mkdirSync(join(source, '.system'), { recursive: true })
      writeFileSync(join(source, '.system', 'checks.yaml'), `checks:\n  - name: x\n    run: "true"\nafterInstall:\n  - name: answers\n    run: "${after}"\n`)
      writeFileSync(join(source, 'n'), String(n))
      git(source, 'add', '-A')
      git(source, 'commit', '-qm', `c${n}`)
      return git(source, 'rev-parse', 'HEAD')
    }
    const c1 = commit(1, 'true')
    const c2 = commit(2, afterInstall)
    mkdirSync(join(base, 'releases'), { recursive: true })
    for (const sha of [c1, c2]) {
      copyRelease(join(base, 'releases', sha))
    }
    // A different code version for the new release; each release is its own copy.
    const file = join(base, 'releases', c2, 'packages', 'app', 'lib', 'client.js')
    const original = readFileSync(file, 'utf8')
    rmSync(file)
    writeFileSync(file, `${original}\n// c2\n`)
    // The install's repo (what `git show <commit>:.system/checks.yaml` and the install-check worktree read).
    execFileSync('git', ['clone', '-q', '--no-checkout', source, join(base, 'repo')])
    symlinkSync(`releases/${c1}`, join(base, 'current.tmp'))
    renameSync(join(base, 'current.tmp'), current)
    assert.equal(cli.run(['init']).status, 0)
    const oldHost = await cli.start()
    const driver = spawn(process.execPath, [join(repo, 'test-support', 'update-driver.mjs'), base, join(base, 'repo'), c2, join(base, 'releases', c1, 'bin', 'system'), '3000000'], { env: cli.env, stdio: ['ignore', 'ignore', 'pipe'] })
    let logged = ''
    driver.stderr.on('data', (d) => { logged += d })
    await until('the update to wait for the Host', () => /waiting for the Host to drain/.test(logged))
    assert.ok(existsSync(join(base, 'pending-install-check.json')), `no pending record: ${logged}`)
    driver.kill('SIGKILL')
    assert.deepEqual(await oldHost.exited, { code: 75, signal: null }, oldHost.stderr())
    // Nobody is left to verify: the unit (here, the test) just starts the Host on `current`.
    const host = await cli.start()
    await check({ base, stderr: () => host.stderr(), c1, c2, link: () => { try { return readlinkSync(current) } catch { return undefined } } })
  } finally {
    await cli.stop()
    rmSync(base, { recursive: true, force: true })
  }
}

describe('pending install check', { concurrency: true }, () => {
test('an update killed while it waits for the drain: the Host that starts on the new release runs the install check, and keeps it when it passes', { timeout: 300_000 }, async () => {
  await scenario('true', async ({ base, stderr, c2, link }) => {
    await until('the pending check to be done and its result logged', () => !existsSync(join(base, 'pending-install-check.json')) && /install checks of [0-9a-f]{12} passed: work:/.test(stderr()))
    assert.match(stderr(), /install checks of [0-9a-f]{12} passed: work:/)
    assert.equal(link(), `releases/${c2}`)
  })
})

test('an update killed while it waits for the drain: a failed install check on the new Host switches current back to the previous release', { timeout: 300_000 }, async () => {
  await scenario('false', async ({ base, stderr, c1, link }) => {
    await until('current to be switched back and the failure logged', () => link() === `releases/${c1}` && !existsSync(join(base, 'pending-install-check.json')) && /install checks of [0-9a-f]{12} failed \(work:[0-9a-f-]+\)/.test(stderr()))
    assert.match(stderr(), /install checks of [0-9a-f]{12} failed \(work:[0-9a-f-]+\)/)
    assert.ok(!existsSync(join(base, 'pending-install-check.json')))
  })
})
})
