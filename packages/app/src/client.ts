/**
 * The thin client entry of `bin/system` (PROP-0004 C6): every command but
 * `init`, `host` and `doctor` runs here, in a process that does not boot DSH
 * and talks to the Host on `$DSH_HOME/system/host.sock`.
 */
// By path, not by package: declaring @system/host here would change the lockfile.
import { VERSION, connect, type Client } from '../../host/lib/index.js'
import { socketPath } from '../../host/lib/process.js'
import { buildProgram, type Run } from './cli.ts'
import { confirmHuman, errorLine, explain, readSecret } from './io.ts'
import { remoteHost } from './remote.ts'

/** Run one command against the Host of `home`; resolves the exit code. */
export async function main(args: string[], home: string): Promise<number> {
  const out = (text: string) => { process.stdout.write(text) }
  const err = (text: string) => { process.stderr.write(text) }
  const open = async (who: { type: 'human' | 'agent'; operatorId: string }): Promise<Client> => {
    const client = await connect(socketPath(home))
    try {
      await client.call('host.hello', { version: VERSION, caller: who })
    } catch (error) {
      client.close()
      throw error
    }
    return client
  }
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
