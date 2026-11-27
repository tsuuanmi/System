/** evalset-1: the review eval set (docs/research/RES-0020) loads, and each case has a diff, a one-sentence answer key and a defect ID. Nothing gates on it. */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const dir = join(import.meta.dirname, 'fixtures', 'review-evalset')
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
const cases = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }))

test('the set holds the seeded Escaped defects of 2026-11-26', () => {
  assert.deepEqual(cases.map((c) => c.defect).sort(), ['ag-2', 'finish-1', 'st-1'])
})

test('each case has a defect ID, a diff and a one-sentence answer key', () => {
  for (const c of cases) {
    assert.equal(c.file, `${c.defect}.json`)
    assert.match(c.defect, /^[a-z]+-\d+$/)
    assert.ok(Array.isArray(c.works) && c.works.length > 0, `${c.defect}: works`)
    assert.match(c.diff, /^diff --git /m, `${c.defect}: diff`)
    assert.equal(typeof c.answerKey, 'string')
    assert.ok(c.answerKey.length > 10 && c.answerKey.length < 400, `${c.defect}: answer key length`)
    assert.equal(c.answerKey.trim().split(/(?<=[.!?])\s+/).length, 1, `${c.defect}: one sentence`)
  }
})

test('the research note lists every case', () => {
  const note = readFileSync(join(import.meta.dirname, '..', 'docs', 'research', 'RES-0020-review-eval-set.md'), 'utf8')
  for (const c of cases) assert.ok(note.includes(`fixtures/review-evalset/${c.file}`), `${c.defect} listed`)
})
