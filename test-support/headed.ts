/**
 * `CHROME` and `skipHeaded` for the tests that need a headed Chrome on a private
 * Xvfb. CHROME is the Chrome the Runtime itself would choose (chrome.ts); where
 * there is no recent one, the pinned Chrome for Testing is installed once into a
 * cache shared by every test process of the user (`SYSTEM_TEST_BROWSERS`, default
 * `<tmp>/system-test-browsers-<uid>`), so a throwaway HOME does not download it
 * again. A browser that cannot start is a failure, not a skip: a test that
 * skips itself everywhere it matters is how the checks once passed on a host
 * where these tests fail. `SYSTEM_SKIP_HEADED=1` (a host that has no Xvfb or
 * no usable Chrome) skips them, with that as the reason.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { discoverChrome, installManagedChrome } from '../packages/web-worker/src/chrome.ts'
import { findXvfb } from '../packages/web-worker/src/display.ts'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Install the managed Chrome once for all the test processes running at the same time: the first takes the lock directory, the others wait for it. */
async function sharedChrome(): Promise<string> {
  const dir = process.env.SYSTEM_TEST_BROWSERS || join(tmpdir(), `system-test-browsers-${userInfo().username}`)
  const choice = discoverChrome(undefined, { managedDir: dir })
  if (choice.source !== 'managed') return choice.path
  const lock = `${dir}.lock`
  // A binary that exists may still be being extracted by another process: it counts only while no one holds the lock.
  if (existsSync(choice.path) && !existsSync(lock)) return choice.path
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      // Another process is installing; a lock that outlives any install is stale.
      if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { recursive: true, force: true })
      await sleep(500)
    }
  }
  try {
    return await installManagedChrome({ dir })
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

export const CHROME = process.env.SYSTEM_SKIP_HEADED ? '' : await sharedChrome()

function reason(): string | false {
  if (process.env.SYSTEM_SKIP_HEADED) return 'SYSTEM_SKIP_HEADED is set'
  if (!findXvfb()) throw new Error('Xvfb is not installed (apt install xvfb), so the headed-browser tests cannot run; SYSTEM_SKIP_HEADED=1 skips them on a host that has none')
  // The message goes to a file: a crashed Chrome's helpers may hold a pipe open while they dump core.
  const dir = mkdtempSync(join(tmpdir(), 'system-headed-'))
  const log = join(dir, 'stderr')
  const fd = openSync(log, 'w')
  const probed = spawnSync(process.execPath, [join(import.meta.dirname, 'headed-probe.ts')], { stdio: ['ignore', 'ignore', fd], timeout: 60_000, env: { ...process.env, CHROME_FOR_PROBE: CHROME } })
  closeSync(fd)
  const message = readFileSync(log, 'utf8').trim().split('\n')[0] ?? ''
  rmSync(dir, { recursive: true, force: true })
  if (probed.status === 0) return false
  throw new Error(`a headed Chrome does not start on a private Xvfb here (${CHROME}: ${message || `exit ${probed.status}`}); SYSTEM_SKIP_HEADED=1 skips the headed-browser tests`)
}

export const skipHeaded = reason()
