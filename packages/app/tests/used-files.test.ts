import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { usedFiles } from '../src/remote.ts'
import * as remote from '../src/remote.ts'

const root = mkdtempSync(join(tmpdir(), 'system-used-'))
after(() => rmSync(root, { recursive: true, force: true }))
const fresh = () => mkdtempSync(join(root, 'd-'))
const uses = (name: string) => `schema: system.workflow/v1\nid: h\nversion: 1\nsteps:\n  - id: c\n    uses: ${name}\n`

// Assert the missing export at runtime so these tests still typecheck before implementation.
function readWorkflowFile(path: string): { workflow: string; uses: Record<string, string> } {
  const read = Reflect.get(remote, 'readWorkflowFile') as ((path: string) => { workflow: string; uses: Record<string, string> }) | undefined
  assert.equal(typeof read, 'function', 'remote.ts must export readWorkflowFile')
  return read!(path)
}

test('readWorkflowFile returns contents and Sub-workflows beside the file', () => {
  const dir = fresh()
  const workflow = uses('sub.yaml')
  writeFileSync(join(dir, 'main.yaml'), workflow)
  writeFileSync(join(dir, 'sub.yaml'), 'x: 1\n')
  assert.deepEqual(readWorkflowFile(join(dir, 'main.yaml')), { workflow, uses: { 'sub.yaml': 'x: 1\n' } })
})

test('readWorkflowFile expands ~ using HOME', () => {
  const dir = fresh()
  const original = process.env.HOME
  const workflow = uses('sub.yaml')
  writeFileSync(join(dir, 'main.yaml'), workflow)
  writeFileSync(join(dir, 'sub.yaml'), 'x: 1\n')
  try {
    process.env.HOME = dir
    assert.deepEqual(readWorkflowFile('~/main.yaml'), { workflow, uses: { 'sub.yaml': 'x: 1\n' } })
  } finally {
    if (original === undefined) delete process.env.HOME
    else process.env.HOME = original
  }
})

test('readWorkflowFile throws ENOENT for a missing path', () => {
  // Resolve the export before assert.throws so a missing implementation is its own assertion.
  assert.equal(typeof Reflect.get(remote, 'readWorkflowFile'), 'function', 'remote.ts must export readWorkflowFile')
  assert.throws(() => readWorkflowFile(join(fresh(), 'missing.yaml')), { code: 'ENOENT' })
})

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
