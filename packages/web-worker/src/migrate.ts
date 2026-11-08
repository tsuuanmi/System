/**
 * Where an Account's state lives (Chrome profile, `state.json` of the circuit breaker, attempts), and the one move of it
 * from where the Runtime was called `chatgpt-web` (WW-rename). The profile moves whole, so no sign-in is needed again.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { exited } from '@system/agents'
import { profileLockPid } from './chatgpt.ts'

/** `<system>/web/<site>/<name>`: the Account's directory; `system` is $DSH_HOME/system. */
export const webStateDir = (system: string, site: string, name: string): string => join(system, 'web', site, name)

/**
 * Move `chatgpt-web/<name>` to `web/<site>/<name>` when the old exists and the new does not, and log one line. Both existing, or
 * a Chrome still holding the old profile, throws with the reason the Account is unavailable: nothing is merged, deleted or moved.
 */
export function moveAccountState(system: string, site: string, name: string, log: (line: string) => void): void {
  const from = join(system, 'chatgpt-web', name)
  const to = webStateDir(system, site, name)
  if (!existsSync(from)) return
  if (existsSync(to)) throw new Error(`both ${from} and ${to} exist; System never merges or deletes: keep the one you want and remove or rename the other, then restart the Host`)
  const holder = profileLockPid(from)
  if (holder !== undefined && !exited(holder)) throw new Error(`a running Chrome (pid ${holder}) holds the profile ${from}; stop it, then restart the Host to move it to ${to}`)
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  renameSync(from, to)
  log(`${from} -> ${to}: the account state moved (the runtime is now web, site ${site}); no sign-in is needed`)
}
