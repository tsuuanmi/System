import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { usedFiles } from '../src/remote.ts'

const root = mkdtempSync(join(tmpdir(), 'system-used-'))
after(() => rmSync(root, { recursive: true, force: true }))
const fresh = () => mkdtempSync(join(root, 'd-'))
const uses = (name: string) => `schema: system.workflow/v1\nid: h\nversion: 1\nsteps:\n  - id: c\n    uses: ${name}\n`

test('a used file not beside the Workflow is left to the Host', () => {
  assert.deepEqual(usedFiles(uses('code-checks.yaml'), fresh()), {})
})

test('a used file beside the Workflow is sent', () => {
  const dir = fresh()
  writeFileSync(join(dir, 'code-checks.yaml'), 'x: 1\n')
  assert.deepEqual(usedFiles(uses('code-checks.yaml'), dir), { 'code-checks.yaml': 'x: 1\n' })
})

test('a file beside it that uses a missing one is sent, and nothing throws', () => {
  const dir = fresh()
  writeFileSync(join(dir, 'a.yaml'), uses('b.yaml'))
  assert.deepEqual(usedFiles(uses('a.yaml'), dir), { 'a.yaml': uses('b.yaml') })
})

test('an error other than a missing file still throws', () => {
  const dir = fresh()
  mkdirSync(join(dir, 'code-checks.yaml'))
  assert.throws(() => usedFiles(uses('code-checks.yaml'), dir), { code: 'EISDIR' })
})
