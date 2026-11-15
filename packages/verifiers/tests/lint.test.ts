/**
 * The lint check (Item fl-10, Escaped defect 4): `@typescript-eslint/no-floating-promises`
 * fails on a promise dropped inside try/finally.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = new URL('../../../', import.meta.url).pathname
const eslint = (...args: string[]) =>
  spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', ...args], { cwd: root, encoding: 'utf8' })

test('lint fails on a promise dropped inside try/finally', () => {
  const result = eslint('--no-ignore', 'packages/verifiers/tests/fixtures/floating-promise.ts')
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /no-floating-promises/)
})
