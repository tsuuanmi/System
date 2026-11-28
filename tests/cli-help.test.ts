/** Item help-1: `--help` and `-h` of `init` and `update` print usage and exit 0 without running the command. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const command of ['init', 'update']) {
  for (const flag of ['--help', '-h']) {
    test(`system ${command} ${flag} prints usage and writes nothing`, () => {
      const home = mkdtempSync(join(tmpdir(), 'system-help-'))
      try {
        const env = { ...process.env, HOME: home, SYSTEM_NO_SERVICE: '1' }
        delete env.DSH_HOME
        delete env.SYSTEM_INSTALL
        const ran = spawnSync(process.execPath, [join(repo, 'bin', 'system'), command, flag], { env, encoding: 'utf8', timeout: 30_000 })
        assert.equal(ran.status, 0, ran.stderr)
        assert.match(ran.stdout, new RegExp(`^usage: system ${command}`, 'm'))
        assert.deepEqual(readdirSync(home), [])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
}
