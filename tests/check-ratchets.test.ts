/** tools/check-ratchets.ts (Item ratchet-1): the `as unknown as` count in packages/<name>/src may only fall, on a temporary git repository. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

const tool = resolve('tools/check-ratchets.ts')
const dir = mkdtempSync(join(tmpdir(), 'ratchets-'))
const baseline = join(dir, '.system', 'ratchets', 'unknown-casts.txt')
const source = (count: number) => Array.from({ length: count }, (_, i) => `export const v${i} = x as unknown as T${i}\n`).join('')
const setSource = (count: number) => {
  writeFileSync(join(dir, 'packages', 'a', 'src', 'index.ts'), source(count))
  execFileSync('git', ['add', '-A'], { cwd: dir })
}
const run = (...args: string[]) => {
  const r = spawnSync('node', [tool, ...args], { cwd: dir, encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

before(() => {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'packages', 'a', 'src'), { recursive: true })
  mkdirSync(join(dir, 'packages', 'a', 'tests'), { recursive: true })
  mkdirSync(join(dir, '.system', 'ratchets'), { recursive: true })
  writeFileSync(join(dir, 'packages', 'a', 'tests', 't.ts'), source(5)) // tests are not counted
  writeFileSync(baseline, '3\n')
  setSource(3)
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('a count equal to the baseline passes', () => {
  const r = run()
  assert.equal(r.status, 0, r.out)
})

test('growth fails, and --prune does not raise the baseline', () => {
  setSource(4)
  const r = run()
  assert.equal(r.status, 1)
  assert.match(r.out, /grew from 3 to 4/)
  assert.equal(run('--prune').status, 1)
  assert.equal(readFileSync(baseline, 'utf8'), '3\n')
})

test('a shrink fails until --prune lowers the baseline', () => {
  setSource(1)
  const r = run()
  assert.equal(r.status, 1)
  assert.match(r.out, /fell from 3 to 1.*--prune/)
  const p = run('--prune')
  assert.equal(p.status, 0, p.out)
  assert.equal(readFileSync(baseline, 'utf8'), '1\n')
  assert.equal(run().status, 0)
})

test('a missing baseline fails', () => {
  rmSync(baseline)
  const r = run()
  assert.equal(r.status, 1)
  assert.match(r.out, /baseline/)
})
