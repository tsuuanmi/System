import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gatedFiles, gatesOf } from '../src/gates.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Item gate-2 (ADR-0016): the committed `.system/checks.yaml` lists this repository's own Gate paths. */
test('the committed checks file gates itself and the workflows, and nothing else of the source', () => {
  const gates = gatesOf(readFileSync(join(repo, '.system', 'checks.yaml'), 'utf8'))
  assert.deepEqual(gates, ['.system/checks.yaml', '.github/workflows/**'])
  assert.deepEqual(gatedFiles(['.system/checks.yaml'], gates), ['.system/checks.yaml'])
  assert.deepEqual(gatedFiles(['.github/workflows/build.yml'], gates), ['.github/workflows/build.yml'])
  assert.deepEqual(gatedFiles(['packages/work/src/status.ts'], gates), [])
})
