/**
 * The thin client entry of `bin/system` (PROP-0004 C6): every command but
 * `init`, `update`, `host` and `doctor` runs here (`bootstrap check` reads git alone and never connects), in a process that does not boot DSH
 * and talks to the Host on `$DSH_HOME/system/host.sock`, and over `operator/host.sock` for an `operator` operation (ADR-0016).
 */
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Caller } from '@system/work'
import { REFUSED, RpcError, VERSION, codeRoot, connectHello, type Client } from '@system/host'
import { operatorSocketPath, socketPath } from '@system/host/process'
import { bootstrapMain } from './bootstrap.ts'
import { buildProgram, type Run } from './cli.ts'
import { confirmHuman, errorLine, explain, readSecret } from './io.ts'
import type { Code } from './mcp.ts'
import { hostClient } from './remote.ts'

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
    // Node pins the target of a symlinked import path for the life of the process, so importing through `current`
    // would keep loading the release the link held at the first import. Import the real path, resolved on every call.
    let lib: string
    let current: typeof import('@system/host')
    try {
      lib = join(realpathSync(codeRoot()), 'packages', 'host', 'lib')
      current = await import(pathToFileURL(join(lib, 'index.js')).href)
    } catch {
      throw error
    }
    if (current.VERSION === VERSION) throw error
    const client = await current.connectHello(socketPath(home), { version: current.VERSION, ...hello })
    try {
      const { operations } = await import(pathToFileURL(join(lib, 'operations.js')).href) as typeof import('@system/host/operations')
      onCode?.({ operations, tableOf: current.tableOf })
    } catch {
      // The list stays as it is; the session works.
    }
    return client
  }
}

/** A test-only override in milliseconds (SYSTEM_WAIT_RECONNECT_MS, SYSTEM_WAIT_RETRY_MS, SYSTEM_CALL_TIMEOUT_MS, SYSTEM_CONNECT_RETRY_MS); unset or not a positive number is none. */
function testMs(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Run one command against the Host of `home`; resolves the exit code. */
export async function main(args: string[], home: string): Promise<number> {
  const out = (text: string) => { process.stdout.write(text) }
  const err = (text: string) => { process.stderr.write(text) }
  const retry = testMs('SYSTEM_CONNECT_RETRY_MS') ?? CONNECT_RETRY
  const timeout = testMs('SYSTEM_CALL_TIMEOUT_MS')
  const open = (who: Caller, { operator, ...options }: { readOnly?: boolean; operator?: boolean } = {}): Promise<Client> => connectHello(operator ? operatorSocketPath(home) : socketPath(home), { version: VERSION, caller: who, retry, ...(timeout === undefined ? {} : { timeout }), ...options })
  if (args[0] === 'bootstrap') {
    try {
      return await bootstrapMain(args, out)
    } catch (error) {
      err(errorLine(error))
      return 1
    }
  }
  if (args[0] === 'mcp') {
    // The code version of this client, so a log shows which release serves a session (Item mcp-2: the front swaps it).
    err(`system mcp: client code ${VERSION}\n`)
    const { runMcp } = await import('./mcp.ts')
    return runMcp(args.slice(1), home, (who, onCode) => openCurrent(home, who, { onCode }))
  }
  let selected: Run | undefined
  const io = { out, err, write: (data: Uint8Array) => { process.stdout.write(data) }, readSecret, confirmHuman }
  buildProgram(hostClient({ open, err, reconnectMs: testMs('SYSTEM_WAIT_RECONNECT_MS'), retryMs: testMs('SYSTEM_WAIT_RETRY_MS') }), io, (run) => { selected = run }, home).parse(args, { from: 'user' })
  if (selected === undefined) return 0
  try {
    return await selected()
  } catch (error) {
    err(errorLine(explain(error, home)))
    return 1
  }
}
