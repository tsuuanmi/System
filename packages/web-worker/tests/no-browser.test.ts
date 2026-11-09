/**
 * WW6l: with SYSTEM_NO_BROWSER=1 (the `test` and `smoke` scripts set it) every launch of Chrome or Xvfb throws at once,
 * before anything is spawned: a test that needs a browser belongs in `test:web`. Stand-ins on PATH and as the
 * configured Chrome record whether they ran.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromeMajor } from '../src/chrome.ts'
import { launch, webDefaults } from '../src/chatgpt.ts'
import { acquireDisplay, startXvfb } from '../src/display.ts'
import { startRemoteLogin } from '../src/remote-login.ts'

const REFUSED = /a browser launch was refused: SYSTEM_NO_BROWSER is set \(this test belongs in test:web\)/
const root = mkdtempSync(join(tmpdir(), 'system-no-browser-'))
const ran = join(root, 'ran')
const saved = { PATH: process.env.PATH, NO_BROWSER: process.env.SYSTEM_NO_BROWSER, DISPLAY: process.env.DISPLAY }

/** A program that records that it was started. */
function stand(name: string): string {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\ntouch ${ran}\n`)
  chmodSync(path, 0o755)
  return path
}

before(() => {
  for (const name of ['Xvfb', 'x11vnc', 'x0vncserver']) stand(name)
  process.env.PATH = `${root}${delimiter}${saved.PATH}`
  process.env.SYSTEM_NO_BROWSER = '1'
  delete process.env.DISPLAY
})
after(() => {
  process.env.PATH = saved.PATH
  for (const [key, value] of [['SYSTEM_NO_BROWSER', saved.NO_BROWSER], ['DISPLAY', saved.DISPLAY]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

test('Xvfb is not started', { timeout: 10_000 }, async () => {
  await assert.rejects(startXvfb(), REFUSED)
  await assert.rejects(acquireDisplay(), REFUSED)
  assert.equal(existsSync(ran), false)
})

test('Chrome is not started, not even to ask its version', { timeout: 10_000 }, async () => {
  const chrome = stand('chrome')
  assert.throws(() => chromeMajor(chrome), REFUSED)
  const web = webDefaults(join(root, 'profile'))
  await assert.rejects(launch({ ...web, executablePath: chrome }, { display: ':1', pid: 0, env: { DISPLAY: ':1' }, stop: async () => {} }), REFUSED)
  assert.equal(existsSync(ran), false)
})

test('a remote login starts nothing', { timeout: 10_000 }, async () => {
  await assert.rejects(startRemoteLogin(webDefaults(join(root, 'profile'))), REFUSED)
  assert.equal(existsSync(ran), false)
})

test('without the variable the guard is off', { timeout: 10_000 }, () => {
  delete process.env.SYSTEM_NO_BROWSER
  try {
    assert.equal(chromeMajor(stand('chrome-2')), undefined)
    assert.equal(existsSync(ran), true, 'the stand-in ran')
  } finally {
    process.env.SYSTEM_NO_BROWSER = '1'
  }
})
