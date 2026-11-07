/**
 * Which Chrome the `chatgpt-web` Runtime runs (chrome.ts): the configured path,
 * `CHROME_PATH`, a system Chrome as new as the engine's Chromium, else the pinned
 * managed build. No browser is started and nothing is downloaded: the installer is injected.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { CHROME_LOCK, discoverChrome, engineChromiumMajor, ensureChrome, installManagedChrome, managedChromePath } from '../src/chrome.ts'

const root = mkdtempSync(join(tmpdir(), 'system-chrome-'))
after(() => rmSync(root, { recursive: true, force: true }))

/** A "Chrome" that reports `version`. */
function fakeChrome(name: string, version: string): string {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\necho "Google Chrome ${version}"\n`)
  chmodSync(path, 0o755)
  return path
}

test('the engine is Chromium 140 or newer, and the pin is not older than it', () => {
  assert.ok(engineChromiumMajor() >= 140)
  assert.ok(Number(CHROME_LOCK.buildId.split('.')[0]) >= engineChromiumMajor())
})

test('the choice is the configured path, CHROME_PATH, a recent system Chrome, then the managed build', () => {
  const old = fakeChrome('old', '95.0.4638.54')
  const recent = fakeChrome('recent', `${engineChromiumMajor()}.0.1.2`)
  const managedDir = join(root, 'browsers')
  const was = process.env.CHROME_PATH
  try {
    delete process.env.CHROME_PATH
    assert.deepEqual(discoverChrome(old, { managedDir }), { path: old, source: 'configured' })
    assert.throws(() => discoverChrome(join(root, 'missing'), { managedDir }), /does not exist/)
    assert.deepEqual(discoverChrome(undefined, { standard: [old, recent], managedDir }), { path: recent, source: 'system' })
    assert.deepEqual(discoverChrome(undefined, { standard: [old], managedDir }), { path: managedChromePath(managedDir), source: 'managed' }, 'a Chrome 95 is too old for the engine')
    process.env.CHROME_PATH = old
    assert.deepEqual(discoverChrome(undefined, { standard: [recent], managedDir }), { path: old, source: 'env' })
  } finally {
    if (was === undefined) delete process.env.CHROME_PATH
    else process.env.CHROME_PATH = was
  }
})

test('the managed Chrome is installed once, on first use, with one install for concurrent callers', async () => {
  const dir = join(root, 'managed')
  let installs = 0
  const install = async (o: { buildId: string; cacheDir: string }) => {
    installs++
    assert.equal(o.buildId, CHROME_LOCK.buildId)
    await new Promise((resolve) => setTimeout(resolve, 50))
    return { executablePath: managedChromePath(o.cacheDir) }
  }
  const paths = await Promise.all([installManagedChrome({ dir, install: install as never }), installManagedChrome({ dir, install: install as never })])
  assert.equal(installs, 1)
  assert.deepEqual(paths, [managedChromePath(dir), managedChromePath(dir)])
  await assert.rejects(installManagedChrome({ dir: join(root, 'fails'), install: (async () => { throw new Error('offline\nmore') }) as never }), /could not install Chrome for Testing .*: offline$/)
})

test('a configured Chrome is used as it is, and nothing is installed for it', async () => {
  const configured = fakeChrome('configured', '1.0.0.0')
  assert.deepEqual(await ensureChrome(configured, join(root, 'never')), { path: configured, source: 'configured' })
})
