/**
 * The thin client entry of `bin/system` (PROP-0004 C6): every command but
 * `init`, `host` and `doctor` runs here, in a process that does not boot DSH
 * and talks to the Host on `$DSH_HOME/system/host.sock`.
 */
// By path, not by package: declaring @system/host here would change the lockfile.
import type { Caller } from '@system/work'
import { VERSION, connectHello, type Client } from '../../host/lib/index.js'
import { socketPath } from '../../host/lib/process.js'
import { buildProgram, type Run } from './cli.ts'
import { confirmHuman, errorLine, explain, readSecret } from './io.ts'
import { runMcp } from './mcp.ts'
import { remoteHost } from './remote.ts'

/** How long a command keeps trying while the Host is away, in milliseconds: the swap of an upgrade takes a moment. */
const CONNECT_RETRY = 3000

/** Run one command against the Host of `home`; resolves the exit code. */
export async function main(args: string[], home: string): Promise<number> {
  const out = (text: string) => { process.stdout.write(text) }
  const err = (text: string) => { process.stderr.write(text) }
  const open = (who: Caller): Promise<Client> => connectHello(socketPath(home), { version: VERSION, caller: who, retry: CONNECT_RETRY })
  if (args[0] === 'mcp') return runMcp(args.slice(1), home, open)
  let selected: Run | undefined
  const io = { out, err, write: (data: Uint8Array) => { process.stdout.write(data) }, readSecret, confirmHuman }
  buildProgram(remoteHost({ open, err }), io, (run) => { selected = run }).parse(args, { from: 'user' })
  if (selected === undefined) return 0
  try {
    return await selected()
  } catch (error) {
    err(errorLine(explain(error, home)))
    return 1
  }
}
