/**
 * The import-boundary lint (ADR-0017 decision 5, Item plug-5): a module under packages/<a>/src
 * imports values from another `@system/*` package only through its `./contract` subpath or a
 * library package, and never by a relative path into another package. `import type` is allowed.
 * Today's violations are baselined per file in eslint.config.js. The source is linted from stdin
 * under the name of an existing file, so no fixture sits in the tree.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = new URL('../../../', import.meta.url).pathname
const lint = (file: string, source: string) =>
  spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', '--stdin', '--stdin-filename', file], {
    cwd: root,
    encoding: 'utf8',
    input: source,
  })

// packages/artifacts/src/index.ts is not in the baseline; packages/app/src/bootstrap.ts is (it keeps a relative import into verifiers, plug-15's neighbour; no entry is against @system/work).
const CLEAN = 'packages/artifacts/src/index.ts'
const BASELINED = 'packages/app/src/bootstrap.ts'

test('a new value import of @system/work from another package fails lint', () => {
  const result = lint(CLEAN, "import { TASK_KIND } from '@system/work'\nexport const kind = TASK_KIND\n")
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /no-restricted-imports/)
})

test('a new mixed import (a value next to a type) of @system/work fails lint', () => {
  const result = lint(CLEAN, "import { TASK_KIND, type Task } from '@system/work'\nexport const kind: Task | typeof TASK_KIND | undefined = TASK_KIND\n")
  assert.equal(result.status, 1, result.stdout + result.stderr)
})

test('a new re-export of a value from a plugin root fails lint', () => {
  const result = lint(CLEAN, "export { TASK_KIND } from '@system/work'\n")
  assert.equal(result.status, 1, result.stdout + result.stderr)
})

test('a new relative import into another package fails lint', () => {
  const result = lint(CLEAN, "import { git } from '../../work/lib/index.js'\nexport const g = git\n")
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /no-restricted-imports/)
})

test('an import type of @system/work passes lint', () => {
  const result = lint(CLEAN, "import type { Task } from '@system/work'\nimport { type WorkRecord } from '@system/work'\nexport type T = Task | WorkRecord\n")
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('a value import through ./contract or from a library package passes lint', () => {
  const result = lint(CLEAN, "import { a } from '@system/work/contract'\nimport { b } from '@system/host'\nimport { c } from '@system/web-driver'\nimport { d } from '@system/git'\nexport const all = [a, b, c, d]\n")
  assert.doesNotMatch(result.stdout, /no-restricted-imports/, result.stdout)
})

test('a baselined file keeps its value import of a plugin root or relative path', () => {
  const result = lint(BASELINED, "import { CHECKS_FILE } from '../../verifiers/lib/checks.js'\nimport { TASK_KIND } from '@system/work'\nexport const s = [CHECKS_FILE, TASK_KIND]\n")
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
