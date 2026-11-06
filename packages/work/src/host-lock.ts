/**
 * The Host lock (PROP-0004 C9): an abstract Unix socket named after the
 * canonical `DSH_HOME`. Whoever binds it is the Host for that home; the kernel
 * releases it when the process dies, so no lock file can be left behind.
 * Linux only.
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { WorkError } from './errors.ts'

export interface HostLock {
  /** The canonical home this lock is for. */
  readonly home: string
  /** Close the socket; the home can be taken at once. */
  release(): Promise<void>
}

/** The abstract socket name for a canonical home: a NUL byte first, so no file exists. */
function hostSocketName(canonicalHome: string): string {
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
