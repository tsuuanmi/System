/**
 * The System app row: reads the launcher's inner arguments, runs one command
 * after the host has started, and exits through the launcher's shutdown path.
 */
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Storage } from '@deepseek-ai/dsh-storage'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { CLASSIFICATIONS, type Artifacts, type Classification } from '@system/artifacts'
import type { AgentsService } from '@system/agents'
import type { Caller, Capabilities, WorkService } from '@system/work'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { buildProgram, type AppHost, type ArtifactCommands, type CredentialCommands, type Run, type WorkCommands, type WorkersView } from './cli.ts'
import { REQUIRED_BACKEND, type StorageStatus } from './doctor.ts'

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

/** The operator a CLI call acts for (ADR-0004 decision 1). */
export function operatorId(): string {
  return process.env.SYSTEM_OPERATOR_ID || userInfo().username
}

function artifactCommands(ctx: Context): ArtifactCommands {
  const artifacts = ctx.get('artifacts') as Artifacts | undefined
  if (!artifacts) throw new Error('the artifacts row is not mounted (run `system doctor`)')
  return {
    putFile: (path, mediaType, classification) => {
      if (!(CLASSIFICATIONS as readonly string[]).includes(classification)) throw new Error(`unknown classification ${classification}`)
      return artifacts.putBytes({
        kind: 'file', schemaVersion: 1, data: readFileSync(path), mediaType,
        classification: classification as Classification, producer: { type: 'operator', ref: operatorId() },
      })
    },
    get: (id) => artifacts.get(id),
    readBytes: (id) => artifacts.readBytes(id),
  }
}

/** Who made this CLI call (ADR-0004 decision 3): a terminal is a human unless SYSTEM_CALLER says otherwise. */
export function caller(): Caller {
  const declared = process.env.SYSTEM_CALLER
  const type = declared === 'human' || declared === 'agent' ? declared : process.stdin.isTTY ? 'human' : 'agent'
  return { type, operatorId: operatorId() }
}

function workCommands(ctx: Context): WorkCommands {
  const work = ctx.get('work') as WorkService | undefined
  if (!work) throw new Error('the work row is not mounted (run `system doctor`)')
  return {
    admitFile: (path, input) => work.admitFile(path, input, caller()),
    admitTask: (capabilities, input) => work.admitTask(capabilities, input, caller()),
    run: (workId) => work.controller.run(workId),
    get: (workId) => work.controller.get(workId),
    list: () => work.controller.list(),
    replay: (workId) => work.controller.replay(workId),
    cancel: (workId, reason) => work.controller.cancel(workId, { reason, caller: caller() }),
    retry: (workId, worker, reason, step) => work.controller.retry(workId, { worker, step, reason, caller: caller() }),
    runningElsewhere: (workId) => work.controller.runningElsewhere(workId),
    newTask: (instructions, repository, ref) => work.newTask(instructions, repository, ref, caller()),
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

/** Read a secret: hidden on a terminal, or the whole of piped stdin less its final newline. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  let value = ''
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') { stdin.off('data', onData); resolve(value); return }
          if (char === '\u0003') { stdin.off('data', onData); reject(new Error('cancelled')); return }
          if (char === '\u007f') value = value.slice(0, -1)
          else value += char
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
    process.stderr.write('\n')
  }
}

function workersView(ctx: Context): WorkersView {
  const capabilities = ctx.get('capabilities') as Capabilities | undefined
  const agents = ctx.get('agents') as AgentsService | undefined
  return { registered: capabilities?.workerRefs() ?? [], accounts: agents?.accounts() ?? [] }
}

export function apply(ctx: Context): void {
  const host: AppHost = {
    hasService: (service) => ctx.get(service as never) !== undefined,
    dshVersion,
    probeStorage: () => probeStorage(ctx),
    artifacts: () => artifactCommands(ctx),
    work: () => workCommands(ctx),
    credentials: () => credentialCommands(ctx),
    workers: () => workersView(ctx),
  }
  let selected: Run | undefined
  const io = { out: (text: string) => { process.stdout.write(text) }, write: (data: Uint8Array) => { process.stdout.write(data) }, readSecret }
  const program = buildProgram(host, io, (run) => { selected = run })
  parseCmdline(ctx, program)
  const run = selected
  if (run === undefined) return
  const exit = ctx.get('appExit')!
  const start = (): void => {
    run().then(exit, (error: unknown) => {
      process.stderr.write(`system: ${(error as Error).stack ?? String(error)}\n`)
      exit(1)
    })
  }
  const ready = ctx.get('appReady')
  if (ready) ready.onReady(start)
  else start()
}
