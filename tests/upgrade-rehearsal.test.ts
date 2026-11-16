/**
 * Item rb-1: the `upgrade` check. The rehearsal (tools/upgrade-rehearsal.mjs) builds the last release (`origin/main`) in a temporary
 * install, starts its Host, and runs THAT install's `system update` to the commit under check. Not in the smoke glob (`tests/*.test.ts`):
 * it builds two releases, so only the `upgrade` check of .system/checks.yaml runs it.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { repo } from '../test-support/cli.ts'

const rehearse = (...args: string[]) => {
  const ran = spawnSync(process.execPath, [join(repo, 'tools', 'upgrade-rehearsal.mjs'), ...args], { cwd: repo, encoding: 'utf8', timeout: 800_000 })
  return { status: ran.status, output: `${ran.stdout}\n${ran.stderr}` }
}

test('an update from the last release keeps this commit as the release, with its afterInstall Verdict passed', { timeout: 850_000 }, () => {
  const ran = rehearse()
  assert.equal(ran.status, 0, ran.output)
  assert.match(ran.output, /upgrade rehearsal passed/)
})

test('Escaped defect 7: a checks.yaml key that the last release does not know fails the rehearsal, naming the refusal', { timeout: 850_000 }, () => {
  const ran = rehearse('--add-check-key', 'keyThatMainDoesNotKnow')
  assert.notEqual(ran.status, 0, ran.output)
  assert.match(ran.output, /upgrade rehearsal failed/)
  assert.match(ran.output, /keyThatMainDoesNotKnow/)
  assert.match(ran.output, /\.system\/checks\.yaml at [0-9a-f]{40} is invalid/)
})
