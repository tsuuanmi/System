/**
 * WW-rename: the per-Account state of `chatgpt-web/<name>` moves once to `web/<site>/<name>`: whole, logged, and never
 * merged or deleted. No browser: Chrome's hold on the profile is the `SingletonLock` link it leaves.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { moveAccountState, webStateDir } from '../src/migrate.ts'

const root = mkdtempSync(join(tmpdir(), 'system-migrate-'))
after(() => rmSync(root, { recursive: true, force: true }))

let count = 0
/** A $DSH_HOME/system with the old directory of `default` (and, when asked, the new one), each holding a marker file. */
function system(old: boolean, current = false) {
  const dir = join(root, `case-${count++}`)
  const from = join(dir, 'chatgpt-web', 'default')
  const to = webStateDir(dir, 'chatgpt', 'default')
  for (const [wanted, path] of [[old, from], [current, to]] as const) {
    if (!wanted) continue
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'state.json'), path)
  }
  const lines: string[] = []
  return { dir, from, to, lines, move: () => moveAccountState(dir, 'chatgpt', 'default', (line) => lines.push(line)) }
}

test('the new directory of an Account is web/<site>/<name>', () => {
  assert.equal(webStateDir('/h/system', 'chatgpt', 'second'), '/h/system/web/chatgpt/second')
})

test('only the old directory exists: it is moved whole and one line is logged', () => {
  const s = system(true)
  s.move()
  assert.equal(existsSync(s.from), false)
  assert.equal(readFileSync(join(s.to, 'state.json'), 'utf8'), s.from, 'the contents came along')
  assert.equal(s.lines.length, 1)
  assert.match(s.lines[0]!, new RegExp(`${s.from} -> ${s.to}`))
})

test('neither exists, or only the new one: nothing happens and nothing is logged', () => {
  for (const s of [system(false), system(false, true)]) {
    s.move()
    assert.deepEqual(s.lines, [])
  }
})

test('both exist: the Account is unavailable with a reason naming both, and neither is touched', () => {
  const s = system(true, true)
  assert.throws(s.move, (error: Error) => error.message.includes(s.from) && error.message.includes(s.to))
  assert.equal(readFileSync(join(s.from, 'state.json'), 'utf8'), s.from)
  assert.equal(readFileSync(join(s.to, 'state.json'), 'utf8'), s.to)
  assert.deepEqual(s.lines, [])
})

test('Chrome holding the old profile: the Account is unavailable and nothing is moved', () => {
  const s = system(true)
  symlinkSync(`testhost-${process.pid}`, join(s.from, 'SingletonLock'))
  assert.throws(s.move, (error: Error) => error.message.includes(s.from) && error.message.includes(String(process.pid)))
  assert.equal(existsSync(s.from), true)
  assert.equal(existsSync(s.to), false)
})

test('a stale lock (its Chrome is gone) does not hold the profile', () => {
  const s = system(true)
  symlinkSync('testhost-2147483646', join(s.from, 'SingletonLock'))
  s.move()
  assert.equal(existsSync(s.to), true)
})
