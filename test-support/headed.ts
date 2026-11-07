/**
 * `skipHeaded`: why a test that needs a headed Chrome on a private Xvfb cannot
 * run here, or false when it can. It starts one for a moment, so a Chrome that
 * is installed but crashes on this machine skips the tests with that reason
 * instead of failing them.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findXvfb } from '../packages/agents/src/display.ts'

export const CHROME = '/usr/bin/google-chrome'

function reason(): string | false {
  if (!existsSync(CHROME)) return `${CHROME} is not installed`
  if (!findXvfb()) return 'Xvfb is not installed'
  // The message goes to a file: a crashed Chrome's helpers may hold a pipe open while they dump core.
  const dir = mkdtempSync(join(tmpdir(), 'system-headed-'))
  const log = join(dir, 'stderr')
  const fd = openSync(log, 'w')
  const probed = spawnSync(process.execPath, [join(import.meta.dirname, 'headed-probe.ts')], { stdio: ['ignore', 'ignore', fd], timeout: 60_000 })
  closeSync(fd)
  const message = readFileSync(log, 'utf8').trim().split('\n')[0] ?? ''
  rmSync(dir, { recursive: true, force: true })
  return probed.status === 0 ? false : `a headed Chrome does not start on a private Xvfb here (${message || `exit ${probed.status}`})`
}

export const skipHeaded = reason()
