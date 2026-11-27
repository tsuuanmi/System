/**
 * Item upd-1: `system update` leaves `<install>/pending-install-check.json` when it switches `current` to a release with afterInstall
 * checks, and removes it when their Verdict passes (or it switches back). A Host that starts on that release while the record is
 * still there runs `system update --finish-pending` of its own release, which submits the install-check Work and switches `current`
 * back on a failure. Nothing else of the update is in the Host: the logic is bin/update.mjs's, a record and a command.
 */
import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const PENDING_INSTALL_CHECK = 'pending-install-check.json'

/** Start the command when this Host runs a release of an install (`<install>/current`) whose record exists; returns whether it did. */
export function completePendingInstallCheck(root: string, log: (line: string) => void, start: typeof spawn = spawn): boolean {
  if (basename(root) !== 'current') return false
  const install = dirname(root)
  if (!existsSync(join(install, PENDING_INSTALL_CHECK))) return false
  log(`a pending install check of this release: running \`system update --finish-pending\``)
  const child = start(process.execPath, [join(realpathSync(root), 'bin', 'system'), 'update', '--finish-pending'], { env: { ...process.env, SYSTEM_INSTALL: install }, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr?.on('data', (data: Buffer) => { process.stderr.write(data) })
  child.on('error', (error) => { log(`could not run it: ${error.message}`) })
  child.unref()
  return true
}
