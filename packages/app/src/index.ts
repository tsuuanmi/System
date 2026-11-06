/**
 * The System app row: reads the launcher's inner arguments, runs one command
 * after the host has started, and exits through the launcher's shutdown path.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Storage } from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { Artifacts, Classification } from '@system/artifacts'
import type { AgentsService } from '@system/agents'
import { dshHome, type Capabilities, type WorkService } from '@system/work'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { buildProgram, type AppHost, type CredentialCommands, type Run, type WorkersView } from './cli.ts'
import { REQUIRED_BACKEND, type HostStatus, type StorageStatus } from './doctor.ts'
import { caller, confirmHuman, errorLine, explain, readSecret } from './io.ts'
// By path, not by package: declaring @system/host here would change the lockfile.
import { VERSION, connect } from '../../host/lib/index.js'
import { serveHost, socketPath } from '../../host/lib/process.js'

export const name = 'system-app'
export const inject = ['cmdlineArgs', 'appExit']

/** A one-record domain the doctor writes and reads back. */
const doctorDomain = defineDomain({
  name: 'system_doctor',
  version: 1,
  tables: { probe: domainTable(z.object({ at: z.string() })) },
})

/** The DSH runtime version, from the launcher's own package (process.argv[1] is its bin). */
function dshVersion(): string {
  try {
    const manifest = join(dirname(process.argv[1] ?? ''), '..', 'package.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string }
    return parsed.name === '@deepseek-ai/dsh' && parsed.version ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function probeStorage(ctx: Context): Promise<StorageStatus> {
  const hub = ctx.get('storage') as Storage | undefined
  const domains = ctx.get('storageDomain') as DomainFacility | undefined
  if (!hub || !domains) return { ok: false, backend: REQUIRED_BACKEND, detail: 'storage services unavailable' }
  try {
    hub.backend.get(REQUIRED_BACKEND)
  } catch (error) {
    return { ok: false, backend: REQUIRED_BACKEND, detail: `backend not registered: ${(error as Error).message}` }
  }
  const domain = await domains.open(doctorDomain)
  try {
    const at = new Date().toISOString()
    await domain.table('probe').put('last', { at })
    const read = domain.table('probe').get('last')
    return read?.at === at
      ? { ok: true, backend: REQUIRED_BACKEND, detail: 'durable write and read back' }
      : { ok: false, backend: REQUIRED_BACKEND, detail: 'read back a different record' }
  } finally {
    await domain.close()
  }
}

/** Whether a Host answers on the socket of `home`: a hello and a ping, in three seconds. */
async function probeHost(home: string): Promise<HostStatus> {
  try {
    const client = await connect(socketPath(home), { timeout: 3000 })
    try {
      await client.call('host.hello', { version: VERSION, caller: caller() })
      const ping = await client.call('host.ping') as { version: string; pid: number }
      return { answering: true, detail: `version ${ping.version}, pid ${ping.pid}` }
    } finally {
      client.close()
    }
  } catch (error) {
    return { answering: false, detail: (explain(error, home) as Error).message }
  }
}

function credentialCommands(ctx: Context): CredentialCommands {
  const store = ctx.get('credentials') as CredentialProvider | undefined
  if (!store) throw new Error('the credentials row is not mounted (run `system doctor`)')
  return {
    set: (name, value) => store.set(credentialRef(name), value),
    describe: (name) => store.describe(credentialRef(name)),
  }
}

async function workersView(ctx: Context): Promise<WorkersView> {
  const capabilities = ctx.get('capabilities') as Capabilities | undefined
  const agents = ctx.get('agents') as AgentsService | undefined
  return { registered: capabilities?.workerRefs() ?? [], accounts: (await agents?.accounts()) ?? [] }
}

/** Be the Host of this home: take the lock, serve the table, and stop on SIGTERM or SIGINT. */
async function runHost(ctx: Context): Promise<void> {
  const work = ctx.get('work') as WorkService | undefined
  const artifacts = ctx.get('artifacts') as Artifacts | undefined
  const capabilities = ctx.get('capabilities') as Capabilities | undefined
  if (!work || !artifacts || !capabilities) throw new Error('the work row is not mounted (run `system doctor`)')
  const home = dshHome(ctx)
  const host = await work.startHost(home)
  const credentials = credentialCommands(ctx)
  const serving = await serveHost({
    host, home,
    log: (line) => { process.stderr.write(`system host: ${line}\n`) },
    services: {
      capabilities,
      putFile: (data, mediaType, classification, who) => artifacts.putBytes({
        kind: 'file', schemaVersion: 1, data, mediaType,
        classification: classification as Classification, producer: { type: 'operator', ref: who.operatorId },
      }),
      artifact: (id) => artifacts.get(id),
      readBytes: (id) => artifacts.readBytes(id),
      newTask: (instructions, repository, ref, context, who) => work.newTask(instructions, repository, ref, who, context),
      newGoal: (goal, supersedes, who) => work.newGoal(goal, supersedes, who),
      addConversation: (parts, asserted, supersedes, who) => work.addConversation(parts, asserted, supersedes, who),
      credentials,
      workers: () => workersView(ctx),
    },
  }).catch(async (error: unknown) => {
    await host.close()
    throw error
  })
  // The launcher stops its tree on a signal and exits 130 for SIGINT; the Host stops itself and exits 0.
  await new Promise<void>((stopped) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.removeAllListeners(signal)
      // A repeat while stopping (systemd also signals the wrapper's child) is ignored.
      process.on(signal, () => { void serving.stop().then(stopped) })
    }
  })
}

/** Every command but `doctor` and `host` is the thin client's: it talks to the Host and never boots DSH. */
function thinOnly(): never {
  throw new Error('this command is a client of the Host: run it as `system <command>`, without DSH flags')
}

export function apply(ctx: Context): void {
  const host: AppHost = {
    hasService: (service) => ctx.get(service as never) !== undefined,
    dshVersion,
    probeStorage: () => probeStorage(ctx),
    probeHost: () => probeHost(dshHome(ctx)),
    artifacts: thinOnly,
    work: thinOnly,
    credentials: thinOnly,
    workers: thinOnly,
    runHost: () => runHost(ctx),
  }
  let selected: Run | undefined
  const io = { out: (text: string) => { process.stdout.write(text) }, err: (text: string) => { process.stderr.write(text) }, write: (data: Uint8Array) => { process.stdout.write(data) }, readSecret, confirmHuman }
  const program = buildProgram(host, io, (run) => { selected = run })
  parseCmdline(ctx, program)
  const run = selected
  if (run === undefined) return
  const exit = ctx.get('appExit')!
  const start = (): void => {
    run().then(exit, (error: unknown) => {
      process.stderr.write(errorLine(error))
      exit(1)
    })
  }
  const ready = ctx.get('appReady')
  if (ready) ready.onReady(start)
  else start()
}
