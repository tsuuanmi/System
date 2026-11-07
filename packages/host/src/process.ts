/**
 * The Host as a process (PROP-0004 C1, C10): the operation table on
 * `$DSH_HOME/system/host.sock` for as long as the process lives. The Host core
 * has taken the lock before this runs, so no other Host serves the home and a
 * socket file found here is stale.
 */
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WorkError, type Host } from '@system/work'
import { VERSION, codeVersion as diskVersion, serve } from './index.ts'
import { operations, type Services } from './operations.ts'

/** Where a home's Host listens. */
export const socketPath = (home: string): string => join(home, 'system', 'host.sock')

/** Where an upgrading Host leaves the Works it held, for the next Host to continue. */
export const upgradePath = (home: string): string => join(home, 'system', 'upgrade.json')

/** The exit status of a Host that stopped to run new code (EX_TEMPFAIL); the unit and `--supervise` restart on it. */
export const UPGRADE_EXIT = 75

/** How often the Host looks at its code on disk, in milliseconds. */
export const UPGRADE_POLL = 10_000

export interface ServeHostOptions {
  host: Host
  home: string
  services: Services
  /** One line per start and stop. */
  log(line: string): void
  /** The code version this Host serves; default: this build's `VERSION`. */
  version?: string
  /** Recompute the code version from the files on disk; default: the `codeVersion` of this package. */
  codeVersion?: () => string
  /** Milliseconds between looks at the disk; default `UPGRADE_POLL`. */
  upgradePoll?: number
}

export interface ServingHost {
  /** The exit status once the Host has stopped: `UPGRADE_EXIT` after an upgrade, 0 after `stop`. */
  exited: Promise<number>
  /** Stop: close the server (so no operation arrives), then the Host core, which refuses what is left and releases the lock. */
  stop(): Promise<void>
}

export async function serveHost(options: ServeHostOptions): Promise<ServingHost> {
  const path = socketPath(options.home)
  // sockaddr_un holds 108 bytes, with the terminating NUL.
  if (Buffer.byteLength(path) > 100) throw new WorkError(`${path} is too long for a Unix socket (about 100 bytes at most); use a shorter DSH_HOME`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (lstatSync(path, { throwIfNoEntry: false })?.isSocket()) rmSync(path)
  const version = options.version ?? VERSION
  const onDisk = options.codeVersion ?? (() => diskVersion())
  let stopping: Promise<void> | undefined
  let upgrading = false
  /** The code this Host is upgrading to, once it is. */
  let target: string | undefined
  let finish!: (status: number) => void
  const exited = new Promise<number>((resolve) => { finish = resolve })
  const stop = () => stopping ??= (async () => {
    await served.close()
    await options.host.close()
    options.log('stopped')
    finish(0)
  })()

  /**
   * The disk's code differs from this Host's: stop dispatching, let the running attempts finish, then leave
   * with the Works whose runs were held, and exit with `UPGRADE_EXIT` for the unit or the supervisor to start
   * the new code. Never interrupts an attempt; a stop asked meanwhile wins and leaves nothing to continue.
   */
  const upgrade = async (now: string): Promise<void> => {
    upgrading = true
    target = now
    options.log(`upgrading: this Host runs ${version}, the code on disk is ${now}; no new attempt starts, running ones finish, then this Host exits ${UPGRADE_EXIT}`)
    await options.host.drain()
    if (stopping) return
    stopping = (async () => {
      // Nothing is accepted from here, so no run begins after the held Works are named.
      await served.close()
      const held = await options.host.held()
      writeFileSync(upgradePath(options.home), JSON.stringify({ works: held }), { mode: 0o600 })
      await options.host.close()
      options.log(`stopped for the upgrade to ${now}, holding ${held.length} Works; exiting ${UPGRADE_EXIT}`)
      finish(UPGRADE_EXIT)
    })()
  }

  /** A hello of another version asks the disk at once; the Host upgrades only to the code that client was built from. Returns the code it is upgrading to, if it is. */
  const asked = (clientVersion: string): string | undefined => {
    if (!upgrading && !stopping) {
      const now = onDisk()
      if (now === clientVersion && now !== version) void upgrade(now)
    }
    return upgrading ? target : undefined
  }

  const served = await serve(options.host, { path, methods: operations(options.services), version, upgrading: asked })
  options.log(`started for ${options.home}, listening on ${path}`)
  continueHeld(options)

  // A change counts once the next look finds the same code again: a build still writing its files is not one.
  let candidate: string | undefined
  const timer = setInterval(() => {
    if (upgrading || stopping) return
    const now = onDisk()
    if (now === version) candidate = undefined
    else if (now === candidate) void upgrade(now).catch((error: unknown) => options.log(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`))
    else candidate = now
  }, options.upgradePoll ?? UPGRADE_POLL)
  timer.unref()
  void exited.then(() => clearInterval(timer))
  return { stop, exited }
}

/** Run the Works the previous Host held for an upgrade, then forget the file: it names what to continue once. */
function continueHeld(options: ServeHostOptions): void {
  const file = upgradePath(options.home)
  let works: string[]
  try {
    works = (JSON.parse(readFileSync(file, 'utf8')) as { works: string[] }).works
  } catch {
    return
  } finally {
    rmSync(file, { force: true })
  }
  const started = options.host.resume(works)
  options.log(`continuing ${started.length} Works held for the upgrade${started.length < works.length ? ` (${works.length - started.length} not continued: finished or interrupted)` : ''}`)
}
