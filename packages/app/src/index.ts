/**
 * The System app row: reads the launcher's inner arguments, runs one command
 * after the host has started, and exits through the launcher's shutdown path.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Storage } from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { Artifacts, Classification } from '@system/artifacts'
import { WEB_WORKER_DISABLED, type AgentsService, type WebWorkerService } from '@system/agents'
import { GIT_TREE_KIND, TASK_KIND, dshHome, git, type Capabilities, type GitTreeContent, type Task, type WorkService } from '@system/work'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { buildHostProgram, type CredentialCommands, type HostProcess, type Run, type WorkersView } from './cli.ts'
import { REQUIRED_BACKEND, type HostStatus, type StorageStatus } from './doctor.ts'
import { caller, errorLine, explain } from './io.ts'
// By path, not by package: declaring @system/host here would change the lockfile.
import { VERSION, codeRoot, connect } from '../../host/lib/index.js'
import { exitWithin, serveHost, socketPath } from '../../host/lib/process.js'

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

/** The Workflow files beside the Host's own code. */
const BUNDLED_WORKFLOWS = fileURLToPath(new URL('../../../workflows/', import.meta.url))

/**
 * A Workflow file a Workflow uses (PROP-0007 decision 7): `workflows/<name>` at
 * the base commit of the input Task, so a Work pins the files of the commit it
 * changes; else the Host's own. Undefined when neither has it.
 */
export function workflowFile(artifacts: Artifacts, name: string, input: string | undefined): string | undefined {
  const content = <T>(id: string | undefined, kind: string): T | undefined => {
    const read = id ? artifacts.get(id) : undefined
    return read?.state === 'stored' && read.envelope.kind === kind ? read.envelope.content as T : undefined
  }
  const base = content<GitTreeContent>(content<Task>(input, TASK_KIND.kind)?.base, GIT_TREE_KIND.kind)
  try {
    if (base) return execFileSync('git', ['-C', base.repository, 'show', `${base.commit}:workflows/${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { /* not in that commit: the Host's own */ }
  try {
    return readFileSync(join(BUNDLED_WORKFLOWS, name), 'utf8')
  } catch {
    return undefined
  }
}

/** Whether a Host answers on the socket of `home`: a hello and a status, in three seconds. */
async function probeHost(home: string): Promise<HostStatus> {
  try {
    const client = await connect(socketPath(home), { timeout: 3000 })
    try {
      await client.call('host.hello', { version: VERSION, caller: caller() })
      const status = await client.call('host.status') as { version: string; pid: number }
      return { answering: true, detail: `version ${status.version}, pid ${status.pid}` }
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

/** The web Runtime's service: its row is optional, and off by default. */
function webWorkerService(ctx: Context): WebWorkerService {
  const web = ctx.get('webWorker') as WebWorkerService | undefined
  if (!web) throw new Error(WEB_WORKER_DISABLED)
  return web
}

/** Whether `commit` is in the code this Host runs (its commit read once): false when it is not (git exits 1 without a message), undefined when git cannot say. */
let running: Promise<string> | undefined
export async function releaseHolds(repository: string, commit: string): Promise<boolean | undefined> {
  try {
    const head = await (running ??= git(realpathSync(codeRoot()), ['rev-parse', 'HEAD']).then((out) => out.trim()))
    await git(repository, ['merge-base', '--is-ancestor', commit, head])
    return true
  } catch (error) {
    return /failed:$/.test((error as Error).message) ? false : undefined
  }
}

/** Be the Host of this home: take the lock, serve the table, and stop on SIGTERM or SIGINT (status 0) or on new code on disk (`UPGRADE_EXIT`). */
async function runHost(ctx: Context): Promise<number> {
  const work = ctx.get('work') as WorkService | undefined
  const artifacts = ctx.get('artifacts') as Artifacts | undefined
  const capabilities = ctx.get('capabilities') as Capabilities | undefined
  if (!work || !artifacts || !capabilities) throw new Error('the work row is not mounted (run `system doctor`)')
  const home = dshHome(ctx)
  // The launcher stops its tree on a signal and exits 130 for SIGINT; the Host stops itself and exits 0. Its handler
  // goes on before the launcher's comes off, so a signal is never lost between the two (libuv drops one sent to a
  // handle being closed), and before the Host says it listens: a stop asked earlier waits until it serves.
  let serving: Awaited<ReturnType<typeof serveHost>> | undefined
  let stopAsked = false
  const onSignal = () => { if (serving) void serving.stop(); else stopAsked = true }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const launcher = process.listeners(signal)
    // A repeat while stopping (systemd also signals the wrapper's child) is ignored.
    process.on(signal, onSignal)
    for (const listener of launcher) process.off(signal, listener)
  }
  const host = await work.startHost(home)
  const credentials = credentialCommands(ctx)
  serving = await serveHost({
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
      newTask: (instructions, repository, ref, context, who, item, against) => work.newTask(instructions, repository, ref, who, context, item, against),
      workflowFile: (name, input) => workflowFile(artifacts, name, input),
      credentials,
      workers: () => workersView(ctx),
      login: async (ref, cookies) => webWorkerService(ctx).login(ref, cookies),
      loginRemote: async (ref) => webWorkerService(ctx).loginRemote(ref),
      loginWait: async (ref, cancel) => webWorkerService(ctx).loginWait(ref, cancel),
      recheck: async (ref) => webWorkerService(ctx).recheck(ref),
      releaseHolds: (repository, commit) => releaseHolds(repository, commit),
    },
  }).catch(async (error: unknown) => {
    await host.close()
    throw error
  })
  if (stopAsked) void serving.stop()
  const status = await serving.exited
  exitWithin(status, { log: (line) => { process.stderr.write(`system host: ${line}\n`) } })
  return status
}

export function apply(ctx: Context): void {
  const host: HostProcess = {
    hasService: (service) => ctx.get(service as never) !== undefined,
    dshVersion,
    probeStorage: () => probeStorage(ctx),
    probeHost: () => probeHost(dshHome(ctx)),
    runHost: () => runHost(ctx),
  }
  let selected: Run | undefined
  const io = { out: (text: string) => { process.stdout.write(text) } }
  const program = buildHostProgram(host, io, (run) => { selected = run })
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
