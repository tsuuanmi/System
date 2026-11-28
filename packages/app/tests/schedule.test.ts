import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseSchedule, readSchedule } from '../src/schedule.ts'

const ok = () => undefined

test('an items Schedule keeps its repositories in order, every `at`, and the optional bounds', () => {
  const s = parseSchedule(`kind: items
repositories: [/w/System, /w/DNA]
at:
  - "*-*-* 01:00"
  - "*-*-* 02..07:00"
maxParallel: 2
checkAt: "*-*-* 00:30"
`, { calendar: ok })
  assert.deepEqual(s, { kind: 'items', repositories: ['/w/System', '/w/DNA'], at: ['*-*-* 01:00', '*-*-* 02..07:00'], maxParallel: 2, checkAt: '*-*-* 00:30' })
})

test('`at` may be one string; maxParallel and checkAt are optional; ~ in a path is the home', () => {
  const s = parseSchedule('kind: items\nrepositories: [~/w/System]\nat: "daily"\n', { calendar: ok })
  assert.deepEqual(s, { kind: 'items', repositories: [join(homedir(), 'w/System')], at: ['daily'] })
})

test('kind: work parses and is refused as not built yet', () => {
  assert.throws(() => parseSchedule('kind: work\nat: daily\nworkflow: develop\ntask: x\n', { calendar: ok }), /kind: work is not built yet/)
})

test('a malformed Schedule is refused with what is wrong', () => {
  const bad: [string, RegExp][] = [
    ['- a', /mapping/],
    ['at: daily\nrepositories: [/a]', /kind/],
    ['kind: weekly\nat: daily\nrepositories: [/a]', /kind/],
    ['kind: items\nat: daily', /repositories/],
    ['kind: items\nat: daily\nrepositories: []', /repositories/],
    ['kind: items\nat: daily\nrepositories: [relative/path]', /absolute/],
    ['kind: items\nrepositories: [/a]', /at/],
    ['kind: items\nat: []\nrepositories: [/a]', /at/],
    ['kind: items\nat: daily\nrepositories: [/a]\nmaxParallel: 0', /maxParallel/],
    ['kind: items\nat: daily\nrepositories: [/a]\nmaxParallel: 1.5', /maxParallel/],
    ['kind: items\nat: daily\nrepositories: [/a]\ncheckAt: 3', /checkAt/],
    ['kind: items\nat: daily\nrepositories: [/a]\nbogus: 1', /bogus/],
    ['kind: items: [', /./],
  ]
  for (const [text, message] of bad) assert.throws(() => parseSchedule(text, { calendar: ok }), message, text)
})

test('each calendar expression goes to the checker, and its complaint refuses the file', () => {
  const seen: string[] = []
  const calendar = (expr: string) => { seen.push(expr); return expr === 'nonsense' ? 'Failed to parse calendar specification' : undefined }
  parseSchedule('kind: items\nrepositories: [/a]\nat: ["daily", "hourly"]\ncheckAt: weekly\n', { calendar })
  assert.deepEqual(seen, ['daily', 'hourly', 'weekly'])
  assert.throws(() => parseSchedule('kind: items\nrepositories: [/a]\nat: [daily, nonsense]\n', { calendar }), /at: "nonsense": Failed to parse/)
})

test('the default checker uses systemd-analyze when it is on the PATH, and passes when it is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'))
  const was = process.env.PATH
  try {
    process.env.PATH = dir
    assert.doesNotThrow(() => parseSchedule('kind: items\nrepositories: [/a]\nat: not a calendar\n'))
    writeFileSync(join(dir, 'systemd-analyze'), '#!/bin/sh\necho "bad: $2" >&2\nexit 1\n', { mode: 0o755 })
    assert.throws(() => parseSchedule('kind: items\nrepositories: [/a]\nat: daily\n'), /at: "daily": bad: daily/)
  } finally {
    process.env.PATH = was
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readSchedule names the file in its errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'))
  try {
    const file = join(dir, 'night.yaml')
    writeFileSync(file, 'kind: items\nat: daily\n')
    assert.throws(() => readSchedule(file, { calendar: ok }), new RegExp(`${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: .*repositories`))
    assert.throws(() => readSchedule(join(dir, 'missing.yaml'), { calendar: ok }), /missing\.yaml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
