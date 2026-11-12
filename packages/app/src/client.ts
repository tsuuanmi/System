/**
 * The thin client entry of `bin/system` (PROP-0004 C6): every command but
 * `init`, `update`, `host` and `doctor` runs here, in a process that does not boot DSH
 * and talks to the Host on `$DSH_HOME/system/host.sock`.
 */
// By path, not by package: declaring @system/host here would change the lockfile.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Caller } from '@system/work'
import { REFUSED, RpcError, VERSION, codeRoot, connectHello, type Client } from '../../host/lib/index.js'
import { socketPath } from '../../host/lib/process.js'
import { buildProgram, type Run } from './cli.ts'
import { confirmHuman, errorLine, explain, readSecret } from './io.ts'
import { runMcp, type Code } from './mcp.ts'
import { remoteHost } from './remote.ts'

/** How long a command keeps trying while the Host is away, in milliseconds: the swap of an upgrade takes a moment. */
const CONNECT_RETRY = 3000

/**
 * Open as `open` does; when the Host refuses this code's version and the code under the install's `current` link is
 * another one (a `system update` came after this process started), say hello again with that code's own client.
 * `system mcp` outlives updates (a session keeps it for days), and this keeps its stdio session alive without a restart:
 * a re-exec could not hand over the SDK's stdio transport, and the Host's wire protocol is what the new code's client
 * speaks. `onCode` is given the new code's operation table builder then, so `system mcp` can list that code's tools.
 */
export async function openCurrent(home: string, who: Caller, { onCode, ...options }: { readOnly?: boolean; onCode?: (code: Code) => void } = {}): Promise<Client> {
  const hello = { caller: who, retry: CONNECT_RETRY, ...options }
  try {
    return await connectHello(socketPath(home), { version: VERSION, ...hello })
  } catch (error) {
    if (!(error instanceof RpcError) || error.code !== REFUSED) throw error
    const lib = join(codeRoot(), 'packages', 'host', 'lib')
    let current: typeof import('../../host/lib/index.js')
    try {
      current = await import(pathToFileURL(join(lib, 'index.js')).href)
    } catch {
      throw error
    }
    if (current.VERSION === VERSION) throw error
    const client = await current.connectHello(socketPath(home), { version: current.VERSION, ...hello })
    try {
      const { operations } = await import(pathToFileURL(join(lib, 'operations.js')).href) as typeof import('../../host/lib/operations.js')
      onCode?.({ operations, tableOf: current.tableOf })
    } catch {
      // The list stays as it is; the session works.
    }
    return client
  }
}

/** A test-only override in milliseconds (SYSTEM_WAIT_RECONNECT_MS, SYSTEM_WAIT_RETRY_MS: the outage bound and first retry wait of `work wait`); unset or not a positive number is none. */
function testMs(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Run one command against the Host of `home`; resolves the exit code. */
export async function main(args: string[], home: string): Promise<number> {
  const out = (text: string) => { process.stdout.write(text) }
  const err = (text: string) => { process.stderr.write(text) }
  const open = (who: Caller, options: { readOnly?: boolean } = {}): Promise<Client> => connectHello(socketPath(home), { version: VERSION, caller: who, retry: CONNECT_RETRY, ...options })
  if (args[0] === 'mcp') return runMcp(args.slice(1), home, (who, onCode) => openCurrent(home, who, { onCode }))
  let selected: Run | undefined
  const io = { out, err, write: (data: Uint8Array) => { process.stdout.write(data) }, readSecret, confirmHuman }
  buildProgram(remoteHost({ open, err, reconnectMs: testMs('SYSTEM_WAIT_RECONNECT_MS'), retryMs: testMs('SYSTEM_WAIT_RETRY_MS') }), io, (run) => { selected = run }).parse(args, { from: 'user' })
  if (selected === undefined) return 0
  try {
    return await selected()
  } catch (error) {
    err(errorLine(explain(error, home)))
    return 1
  }
}
