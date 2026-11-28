/**
 * The System app row: reads the launcher's inner arguments, runs one command
 * after the host has started, and exits through the launcher's shutdown path.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Storage } from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { Artifacts, Classification } from '@system/artifacts/contract'
import { git } from '@system/git'
import type { FailureClassifier, GitTreeContent, Task, WorkService } from '@system/work'
import { GIT_TREE_KIND, TASK_KIND, dshHome, profileMigrationOfFiles, type Capabilities } from '@system/work/contract'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { buildHostProgram, type HostProcess, type Run, type WorkersView } from './cli.ts'
import { REQUIRED_BACKEND, type HostStatus, type StorageStatus } from './doctor.ts'
import { checkStore } from './store-check.ts'
import { completePendingInstallCheck } from './pending-install-check.ts'
import { caller, errorLine, explain } from './io.ts'
import { VERSION, codeRoot, connect } from '@system/host'
import type { Services } from '@system/host/operations'
import { exitWithin, operatorSocketPath, serveHost, socketPath } from '@system/host/process'

export const name = 'system-app'
export const inject = ['cmdlineArgs', 'appExit']

/** A domain whose records the doctor writes, reads back and deletes, one per probe. */
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

/**
 * Write a record and read it back. The key is this probe's own: every `system` command probes the one store, and a
 * shared key let another process's write land between this write and read ("read back a different record" under load).
 */
export async function probeStorage(ctx: Pick<Context, 'get'>): Promise<StorageStatus> {
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
    const key = `probe-${process.pid}-${randomUUID()}`
    await domain.table('probe').put(key, { at })
    const read = domain.table('probe').get(key)
    await domain.table('probe').delete(key)
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
export function workflowFile(artifacts: Context['artifacts'], name: string, input: string | undefined): string | undefined {
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
/** Whether the operator socket (ADR-0016) answers a hello: the one the operator commands need. */
async function operatorAnswers(home: string): Promise<boolean> {
  try {
    const client = await connect(operatorSocketPath(home), { timeout: 3000 })
    try {
      await client.call('host.hello', { version: VERSION, caller: caller() })
      return true
    } finally {
      client.close()
    }
  } catch {
    return false
  }
}

async function probeHost(home: string): Promise<HostStatus> {
  try {
    const client = await connect(socketPath(home), { timeout: 3000 })
    try {
      await client.call('host.hello', { version: VERSION, caller: caller() })
      const status = await client.call('host.status') as { version: string; pid: number }
      return { answering: true, detail: `version ${status.version}, pid ${status.pid}; operator socket ${await operatorAnswers(home) ? 'answering' : 'not answering (restart the Host: it makes it at start)'}` }
    } finally {
      client.close()
    }
  } catch (error) {
    return { answering: false, detail: (explain(error, home) as Error).message }
  }
}

/**
 * The optional services the app reads, each declared through `ctx.inject` so a Host composed without one still runs `system doctor`
 * (the app stays active) and a command that needs it names it. A service is here while its row is up; `get` is the same answer as
 * `ctx.get` for the names in `OPTIONAL`.
 */
const OPTIONAL = ['appReady', 'artifacts', 'capabilities', 'classifier', 'credentials', 'storage', 'storageDomain', 'work'] as const
type Optional = typeof OPTIONAL[number]
/** The type of each service: its contract's `Context` entry where a contract declares one, else the shape the app reads. */
interface Provided {
  appReady: NonNullable<Context['appReady']>
  artifacts: Context['artifacts']
  capabilities: Context['capabilities']
  classifier: { failures: FailureClassifier }
  credentials: CredentialProvider
  storage: Storage
  storageDomain: DomainFacility
  work: Context['work']
}
interface Mounted {
  get<K extends Optional>(name: K): Provided[K] | undefined
  /** The services named, or an error naming those not available. */
  need<K extends Optional>(...names: K[]): { [N in K]: Provided[N] }
}

function track(ctx: Context): Mounted {
  const live = new Map<Optional, unknown>()
  for (const name of OPTIONAL) {
    ctx.inject([name], (inner) => {
      live.set(name, (inner as Context).get(name))
      inner.effect(() => () => { live.delete(name) }, `${name} service`)
    })
  }
  return {
    get: (name) => live.get(name) as never,
    need: (...names) => {
      const missing = names.filter((name) => live.get(name) === undefined)
      if (missing.length) throw new Error(`the ${missing.join(' and ')} service${missing.length > 1 ? 's are' : ' is'} not available (run \`system doctor\`)`)
      return Object.fromEntries(names.map((name) => [name, live.get(name)])) as never
    },
  }
}

function credentialCommands(mounted: Mounted): Services['credentials'] {
  const { credentials: store } = mounted.need('credentials')
  return {
    set: (name, value) => store.set(credentialRef(name), value),
    describe: (name) => store.describe(credentialRef(name)),
  }
}

export async function workersView(mounted: Pick<Mounted, 'get'>): Promise<WorkersView> {
  const capabilities = mounted.get('capabilities')
  // Every Runtime's Accounts come from its Workers' registrations (ADR-0018): none of a Runtime's own service is read.
  return { registered: capabilities?.workerRefs() ?? [], accounts: (await capabilities?.accounts()) as WorkersView['accounts'] ?? [] }
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
async function runHost(ctx: Context, mounted: Mounted): Promise<number> {
  const { work, artifacts, capabilities } = mounted.need('work', 'artifacts', 'capabilities')
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
  // The optional classifier row (cls-1): a Work that ends has the failures no rule places classified, for `work report`; never in the controller's way.
  const classifier = mounted.get('classifier')
  const stopClassifying = classifier && host.view.onChange((change) => {
    if (change.type !== 'terminal') return
    const record = host.view.get(change.workId)
    if (record) void classifier.failures.classify(record).catch(() => {})
  })
  const credentials = credentialCommands(mounted)
  const pollOverride = Number(process.env.SYSTEM_UPGRADE_POLL_MS)
  const upgradePoll = Number.isFinite(pollOverride) && pollOverride > 0 ? pollOverride : undefined
  serving = await serveHost({
    host, home,
    ...(upgradePoll === undefined ? {} : { upgradePoll }),
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
      newIntent: (intent, who) => work.newIntent(intent, who),
      newDefect: (defect, who) => work.newDefect(defect, who),
      newConfirmation: (confirmation, who) => work.newConfirmation(confirmation, who),
      operatorActs: () => work.operatorActs(),
      newReleaseApproval: (commit, who) => work.newReleaseApproval(commit, who),
      releaseApprovals: () => work.releaseApprovals(),
      withdrawDefect: (input, who) => work.withdrawDefect(input, who),
      defects: () => work.defects(),
      defectWithdrawals: () => work.defectWithdrawals(),
      workflowFile: (name, input) => workflowFile(artifacts, name, input),
      credentials,
      workers: () => workersView(mounted),
      releaseHolds: (repository, commit) => releaseHolds(repository, commit),
      ...(classifier ? { classifier: classifier.failures } : {}),
    },
  }).catch(async (error: unknown) => {
    await host.close()
    throw error
  })
  if (stopAsked) void serving.stop()
  else completePendingInstallCheck(codeRoot(), (line) => { process.stderr.write(`system host: ${line}\n`) })
  const status = await serving.exited
  stopClassifying?.()
  exitWithin(status, { log: (line) => { process.stderr.write(`system host: ${line}\n`) } })
  return status
}

/** Item rt-4: a profile that patches the old rows, or lists a web Account under the CLI row, does not start (ADR-0018 decision 5). Read from the patch files dsh read, never rewritten. */
function profileProblem(ctx: Context): string | undefined {
  const profile = ctx.get('profileContext')
  return profile && profileMigrationOfFiles([profile.patchPath, join(profile.home, 'cordis.patch.yml')], profile.overlays.flat())
}

/** The row has no configuration; a config that is not an object is refused at activation. */
export interface Config {}
export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context, _config: Config): void {
  const mounted = track(ctx)
  const host: HostProcess = {
    hasService: (service) => ctx.get(service as never) !== undefined,
    dshVersion,
    probeStorage: () => probeStorage(mounted),
    probeHost: () => probeHost(dshHome(ctx)),
    checkStore: () => {
      const { work, artifacts } = mounted.need('work', 'artifacts')
      return checkStore({ works: work.records(), artifacts })
    },
    runHost: () => runHost(ctx, mounted),
    profileProblem: () => profileProblem(ctx),
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
  // The services declared above are mounted by the next turn of the loop, not inside this call.
  setImmediate(() => {
    const ready = mounted.get('appReady')
    if (ready) ready.onReady(start)
    else start()
  })
}
