/**
 * One account of one agent CLI as a System Worker (ADR-0004 decisions 4-6,
 * ADR-0005). Each attempt: prepare the workspace, run the CLI headless through
 * a `Spawner` (the DSH subprocess service in production), capture outputs,
 * store a bounded log, clean up. Cancellation aborts the process range with a
 * 30 s grace; whatever the attempt produced is kept as unaccepted partial output.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Artifacts } from '@system/artifacts'
import { requestedTier, type Tier, type WorkerPort, type WorkerRequest, type WorkerResult } from '@system/work'
import { claudeInvocation, codexInvocation, parseClaude, parseCodex, type Runtime } from './runtimes.ts'
import { capture, cleanup, prepare, prompt } from './workspace.ts'

const GRACE_MS = 30_000
const MAX_LOG_BYTES = 256 * 1024

export interface SpawnSpec {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  signal: AbortSignal
  graceMs: number
}

export interface Spawned {
  done: Promise<{ exitCode: number | null; signal: string | null }>
  stdout(): string
  stderr(): string
}

export interface Spawner {
  spawn(spec: SpawnSpec): Spawned
}

export interface Account {
  ref: string
  runtime: Runtime
  capabilities: string[]
  /** Absolute path of the CLI. */
  command: string
  /** Its `--version` output, asked when first needed. */
  version: () => Promise<string>
  /** claude-code: resolves the credential named by the account's tokenRef. */
  token?: () => Promise<string | undefined>
  /** codex: the account's System-owned CODEX_HOME holding `auth.json`. */
  codexHome?: string
  /** The model to run for each offered tier; a step with no tier gets `standard`, else the CLI's default. */
  models?: Partial<Record<Tier, string>>
}

const digest = (path: string) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '')

/** Every attempt of one account runs after the previous one: Codex refreshes its auth file. */
const queues = new Map<string, Promise<unknown>>()

export function agentWorker(account: Account, artifacts: Artifacts, spawner: Spawner, attemptsDir: string, graceMs = GRACE_MS): WorkerPort {
  return {
    ref: account.ref,
    capabilities: account.capabilities,
    run(request) {
      const previous = queues.get(account.ref) ?? Promise.resolve()
      const run = () => attempt(account, artifacts, spawner, attemptsDir, request, graceMs)
      const next = previous.then(run, run)
      queues.set(account.ref, next.catch(() => undefined))
      return next
    },
  }
}

async function attempt(account: Account, artifacts: Artifacts, spawner: Spawner, attemptsDir: string, request: WorkerRequest, graceMs: number): Promise<WorkerResult> {
  const tier = requestedTier(request.capabilities)
  const model = tier ? account.models?.[tier] : account.models?.standard
  const executor: NonNullable<WorkerResult['executor']> = {
    ref: account.ref, account: account.ref.split('/').slice(1).join('/') || account.ref, command: account.command, version: await account.version(),
    ...(tier ? { tier } : {}), ...(model ? { model } : {}),
  }
  const ws = await prepare(artifacts, request, join(attemptsDir, request.attemptId.replace(/[^a-z0-9-]/gi, '_')))
  try {
    const text = prompt(ws, request)
    let invocation
    let codexAuth: { attempt: string; account: string; before: string } | undefined
    if (account.runtime === 'claude-code') {
      const token = await account.token?.()
      if (!token) return { status: 'failed', outputs: {}, reason: `${account.ref}: its token is not configured (system credentials set)`, executor }
      invocation = claudeInvocation(account.command, ws, text, token, model)
    } else {
      const home = join(ws.root, 'codex-home')
      mkdirSync(home, { mode: 0o700 })
      const source = join(account.codexHome!, 'auth.json')
      if (!existsSync(source)) return { status: 'failed', outputs: {}, reason: `${account.ref}: no auth.json in ${account.codexHome} (codex login --device-auth)`, executor }
      // A fresh CODEX_HOME per attempt holding only auth.json: no memories or history carry over (ADR-0005).
      copyFileSync(source, join(home, 'auth.json'))
      codexAuth = { attempt: join(home, 'auth.json'), account: source, before: digest(source) }
      invocation = codexInvocation(account.command, ws, text, home, model)
    }
    // Remove every host variable the agent was not given (SSH agent, tokens, ...).
    const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]))
    Object.assign(env, invocation.env)
    const spawned = spawner.spawn({ argv: invocation.argv, cwd: ws.work, env, signal: request.signal, graceMs })
    const outcome = await spawned.done
    const stdout = spawned.stdout()
    const parsed = account.runtime === 'claude-code' ? parseClaude(stdout) : parseCodex(stdout)
    if (codexAuth) keepRefreshedAuth(codexAuth)
    if (parsed.servedModels?.length) executor.servedModels = parsed.servedModels
    const log = (await artifacts.putBytes({
      kind: 'file', schemaVersion: 1, data: Buffer.from(stdout.slice(-MAX_LOG_BYTES)),
      mediaType: 'application/x-ndjson',
      classification: 'local-private', producer: { type: 'worker', ref: account.ref }, workId: request.workId, attemptId: request.attemptId,
    })).id
    const captured = await capture(artifacts, ws, request, account.ref)
    const common = { log, usage: parsed.usage, executor }
    // A stopped agent's output is incomplete, so its usage is unknown rather than a partial count.
    if (request.signal.aborted) return { status: 'cancelled', outputs: {}, partial: captured.outputs, reason: 'cancelled; the agent was stopped', log, executor }
    if (outcome.exitCode !== 0 || !parsed.ok) {
      const why = outcome.signal ? `signal ${outcome.signal}` : `exit ${outcome.exitCode}`
      return { status: 'failed', outputs: {}, partial: captured.outputs, reason: `${account.ref} ${why}: ${(parsed.message || spawned.stderr()).slice(0, 500)}`, ...common }
    }
    if (captured.missing.length) {
      return { status: 'failed', outputs: {}, partial: captured.outputs, reason: `${account.ref} wrote no output file for ${captured.missing.join(', ')}`, ...common }
    }
    return { status: 'succeeded', outputs: captured.outputs, ...common }
  } finally {
    await cleanup(ws)
  }
}

/** Copy a refreshed `auth.json` back, unless the account's file changed meanwhile. */
function keepRefreshedAuth(auth: { attempt: string; account: string; before: string }): void {
  if (!existsSync(auth.attempt) || digest(auth.attempt) === auth.before || digest(auth.account) !== auth.before) return
  const staged = join(dirname(auth.account), `.auth.json.${process.pid}`)
  copyFileSync(auth.attempt, staged)
  renameSync(staged, auth.account)
}
