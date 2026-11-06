/**
 * The Host lock (PROP-0004 C9): an abstract Unix socket named after the
 * canonical `DSH_HOME`. Whoever binds it is the Host for that home; the kernel
 * releases it when the process dies, so no lock file can be left behind.
 * Linux only. It does not replace `FileControl` before the cutover (H4).
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { WorkError } from './errors.ts'

export interface HostLock {
  /** The canonical home this lock is for. */
  readonly home: string
  /** Close the socket; the home can be taken at once. */
  release(): Promise<void>
}

/** The abstract socket name for a canonical home: a NUL byte first, so no file exists. */
export function hostSocketName(canonicalHome: string): string {
  return `\0system-host:${createHash('sha256').update(canonicalHome).digest('hex')}`
}

/** Take the lock for `home`; refuses when another process holds it. `platform` is for tests. */
export async function acquireHostLock(home: string, options: { platform?: NodeJS.Platform } = {}): Promise<HostLock> {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') throw new WorkError(`the Host lock needs Linux abstract Unix sockets; this is ${platform}`)
  let canonical: string
  try {
    canonical = realpathSync(home)
  } catch {
    throw new WorkError(`DSH_HOME ${home} does not exist`)
  }
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((bound, refuse) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      refuse(error.code === 'EADDRINUSE' ? new WorkError(`another Host already runs for ${canonical}`) : error)
    })
    server.listen({ path: hostSocketName(canonical) }, bound)
  })
  return {
    home: canonical,
    release: () => new Promise<void>((closed) => { server.close(() => closed()) }),
  }
}

/** Whether a Host holds `home` now: a connection to its lock is answered. It takes nothing, so it cannot make a starting Host fail. */
export function hostHeld(home: string): Promise<boolean> {
  let canonical: string
  try {
    canonical = realpathSync(home)
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((answer) => {
    const socket = createConnection({ path: hostSocketName(canonical) })
    socket.once('connect', () => { socket.destroy(); answer(true) })
    socket.once('error', () => answer(false))
  })
}
