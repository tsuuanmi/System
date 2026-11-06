/**
 * The Host as a process (PROP-0004 C1, C10): the operation table on
 * `$DSH_HOME/system/host.sock` for as long as the process lives. The Host core
 * has taken the lock before this runs, so no other Host serves the home and a
 * socket file found here is stale.
 */
import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WorkError, type Host } from '@system/work'
import { serve } from './index.ts'
import { operations, type Services } from './operations.ts'

/** Where a home's Host listens. */
export const socketPath = (home: string): string => join(home, 'system', 'host.sock')

export interface ServeHostOptions {
  host: Host
  home: string
  services: Services
  /** One line per start and stop. */
  log(line: string): void
}

export interface ServingHost {
  /** Stop: close the server (so no operation arrives), then the Host core, which refuses what is left and releases the lock. */
  stop(): Promise<void>
}

export async function serveHost(options: ServeHostOptions): Promise<ServingHost> {
  const path = socketPath(options.home)
  // sockaddr_un holds 108 bytes, with the terminating NUL.
  if (Buffer.byteLength(path) > 100) throw new WorkError(`${path} is too long for a Unix socket (about 100 bytes at most); use a shorter DSH_HOME`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (lstatSync(path, { throwIfNoEntry: false })?.isSocket()) rmSync(path)
  const served = await serve(options.host, { path, methods: operations(options.services) })
  options.log(`started for ${options.home}, listening on ${path}`)
  let stopping: Promise<void> | undefined
  return {
    stop: () => stopping ??= (async () => {
      await served.close()
      await options.host.close()
      options.log('stopped')
    })(),
  }
}
