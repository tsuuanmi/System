/**
 * Item install-1: the `install-guide` check. A new machine runs the commands of the runbook's "Install and start" page (the fenced
 * block marked `sh install`) from an empty HOME and the commit under check, registers the fake Worker, starts the Host without
 * systemd and runs one Work to `succeeded`. Not in the smoke glob: it builds a release.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { repo, systemCli } from '../test-support/cli.ts'
import { withFakes } from '../test-support/fakes.ts'

const FAKES_ON = withFakes({ workers: ['repo.write', 'develop.implement', 'tier.standard'], verifiers: ['code.required-checks'], effects: ['git.publish'] })

/** The commands of the page: every line of its fenced blocks whose info string is `sh install`. */
export function pageCommands(markdown: string): string[] {
  return [...markdown.matchAll(/^```sh install\n([\s\S]*?)^```$/gm)].map((match) => match[1]!.trim()).filter(Boolean)
}

/** Run the page's commands in a clone of this commit, from an empty HOME; `edit` may break the page first (the negative case). */
function runPage(edit: (page: string) => string = (page) => page) {
  const scratch = mkdtempSync('/tmp/inst-')
  const page = edit(readFileSync(join(repo, 'docs', 'operations', 'install-and-update.md'), 'utf8'))
  const commands = pageCommands(page)
  assert.ok(commands.length > 0, 'the runbook page has a `sh install` block')
  const home = join(scratch, 'home')
  const clone = join(scratch, 'System')
  spawnSync('mkdir', ['-p', home])
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  // A clone of the commit under check; the working tree on top of it, so an uncommitted page or script is checked too (the release itself is built from the commit).
  for (const args of [['clone', '-q', '--no-checkout', repo, clone], ['-C', clone, 'checkout', '-q', '--detach', head]]) assert.equal(spawnSync('git', args, { encoding: 'utf8' }).status, 0)
  spawnSync('rsync', ['-a', '--exclude=.git', '--exclude=node_modules', '--exclude=dist', '--exclude=.build*', `${repo}/`, `${clone}/`])
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SYSTEM_INSTALL: join(home, '.system'), DSH_HOME: join(home, '.dsh'), SYSTEM_NO_SERVICE: '1' }
  delete env.SYSTEM_CODE
  const ran = spawnSync('bash', ['-ec', commands.join('\n')], { cwd: clone, env, encoding: 'utf8', timeout: 600_000 })
  return { scratch, home, env, ran }
}

test('the runbook page installs System on an empty HOME and runs one Work to succeeded with a fake Worker', { timeout: 840_000 }, async () => {
  const { scratch, home, env, ran } = runPage()
  try {
    assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`)
    const cli = systemCli('system-install', { SYSTEM_OPERATOR_ID: 'tester', SYSTEM_INSTALL: env.SYSTEM_INSTALL!, HOME: home }, env.DSH_HOME!, join(env.SYSTEM_INSTALL!, 'current', 'bin', 'system'))
    try {
      writeFileSync(join(env.DSH_HOME!, 'profiles', 'system', 'cordis.patch.yml'), FAKES_ON)
      await cli.start()
      const task = join(scratch, 'task.txt')
      writeFileSync(task, 'make the tests pass\n')
      const input = cli.run(['artifact', 'put', task, '--media-type', 'text/plain']).stdout.trim()
      const submitted = cli.run(['work', 'submit', '--capability', 'repo.write', '--input', input])
      assert.equal(submitted.status, 0, submitted.stderr)
      const shown = JSON.parse(cli.run(['work', 'show', submitted.stdout.trim().split('\n')[0]!]).stdout) as { state: { status: string } }
      assert.equal(shown.state.status, 'succeeded')
    } finally {
      await cli.stop()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('a broken command on the page fails the check', { timeout: 300_000 }, () => {
  const { scratch, ran } = runPage((page) => page.replace('```sh install\ntools/install.sh', '```sh install\ntools/no-such-install.sh'))
  try {
    assert.notEqual(ran.status, 0)
    assert.match(ran.stderr, /no-such-install\.sh/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
