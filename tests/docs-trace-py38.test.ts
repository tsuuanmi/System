/**
 * `tools/docs.py` promises Python 3.8+: `str.removeprefix`/`removesuffix` need 3.9, so `trace` failed there with AttributeError.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('tools/docs.py uses no str.removeprefix or removesuffix (Python 3.8)', () => {
  const source = readFileSync('tools/docs.py', 'utf8')
  assert.doesNotMatch(source, /\.(removeprefix|removesuffix)\(/)
})

test('docs.py trace runs on python3.8 when that interpreter exists', (t) => {
  if (spawnSync('python3.8', ['--version']).status !== 0) return t.skip('python3.8 is not installed')
  const run = spawnSync('python3.8', ['tools/docs.py', 'trace', 'docs/architecture/control-plane.md'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
})
