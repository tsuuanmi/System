/** One independent ACP WorkerPort. System retains all Work/Artifact authority. */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Artifacts } from '@system/artifacts'
import type { WorkerPort, WorkerRequest, WorkerResult } from '@system/work'
import { capture, cleanup, goneFromPidFile, pidFile, prepare, prompt, type Spawner } from '@system/worker-execution'
import { acpInvocation, acpProgress, parseAcp } from './protocol.ts'

const GRACE_MS = 30_000
const MAX_LOG_BYTES = 256 * 1024
const PROGRESS_MS = 500
const DEFAULT_ATTEMPT_TIMEOUT_MINUTES = 60

export interface AcpAccount {
  ref: string
  capabilities: string[]
  command: string
  agentCommand: string
  agentArgs: string[]
  version: () => Promise<string>
  token?: () => Promise<string | undefined>
  codexHome?: string
  maxConcurrentAttempts?: number
  attemptTimeoutMinutes?: number
  attemptBudget?: { minutes?: number }
}

const digest = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : ''

/** Keep a provider-refreshed Codex auth.json only if the account copy was unchanged. */
function keepRefreshedAuth(auth: { attempt: string; account: string; before: string }): void {
  if (!existsSync(auth.attempt) || digest(auth.attempt) === auth.before || digest(auth.account) !== auth.before) return
  const staged = join(dirname(auth.account), `.auth.json.${process.pid}`)
  copyFileSync(auth.attempt, staged)
  renameSync(staged, auth.account)
}

export function acpWorker(account: AcpAccount, artifacts: Artifacts, spawner: Spawner, attemptsDir: string): WorkerPort {
  return {
    ref: account.ref,
    capabilities: account.capabilities,
    maxConcurrentAttempts: account.maxConcurrentAttempts,
    async gone(attemptId) { return goneFromPidFile(attemptsDir, attemptId) },
    run(request) { return attempt(account, artifacts, spawner, attemptsDir, request) },
  }
}

async function attempt(
  account: AcpAccount,
  artifacts: Artifacts,
  spawner: Spawner,
  attemptsDir: string,
  request: WorkerRequest,
): Promise<WorkerResult> {
  const executor: NonNullable<WorkerResult['executor']> = {
    ref: account.ref, account: account.ref.split('/').slice(1).join('/') || account.ref,
    command: account.command, version: await account.version(),
  }
  const ws = await prepare(artifacts, request, join(attemptsDir, request.attemptId.replace(/[^a-z0-9-]/gi, '_')))
  try {
    const text = prompt(ws, request)
    const promptFile = join(ws.root, 'acp-prompt.txt')
    writeFileSync(promptFile, text, { mode: 0o600 })

    let token: string | undefined
    if (account.token) {
      token = await account.token()
      if (!token) return { status: 'failed', outputs: {}, reason: `${account.ref}: account credential is unavailable`, executor }
    }

    let codexHome: string | undefined
    let codexAuth: { attempt: string; account: string; before: string } | undefined
    if (account.codexHome) {
      codexHome = join(ws.root, 'codex-home')
      mkdirSync(codexHome, { mode: 0o700 })
      const source = join(account.codexHome, 'auth.json')
      if (!existsSync(source)) return { status: 'failed', outputs: {}, reason: `${account.ref}: auth.json unavailable`, executor }
      const attemptAuth = join(codexHome, 'auth.json')
      copyFileSync(source, attemptAuth)
      codexAuth = { attempt: attemptAuth, account: source, before: digest(source) }
    }

    const invocation = acpInvocation(account.command, ws, promptFile, account.agentCommand, account.agentArgs, token, codexHome)
    const env: Record<string, string | undefined> = Object.fromEntries(
      Object.keys(process.env).map((key) => [key, undefined]),
    )
    Object.assign(env, invocation.env)
    const limit = account.attemptTimeoutMinutes ?? DEFAULT_ATTEMPT_TIMEOUT_MINUTES
    const stop = new AbortController()
    const onAbort = () => stop.abort()
    if (request.signal.aborted) onAbort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    let overBudget = false
    const timer = setTimeout(() => { timedOut = true; onAbort() }, limit * 60_000)
    const budgetTimer = account.attemptBudget?.minutes === undefined ? undefined :
      setTimeout(() => { overBudget = true; onAbort() }, account.attemptBudget.minutes * 60_000)
    let spawned: ReturnType<Spawner['spawn']>
    try {
      spawned = spawner.spawn({
        argv: invocation.argv, cwd: ws.work, env, signal: stop.signal,
        graceMs: GRACE_MS, pidFile: pidFile(attemptsDir, request.attemptId),
      })
    } catch (error) {
      clearTimeout(timer)
      clearTimeout(budgetTimer)
      request.signal.removeEventListener('abort', onAbort)
      throw error
    }
    const read = acpProgress()
    let observed = 0
    const watcher = setInterval(() => {
      const output = spawned.stdout()
      if (output.length === observed) return
      observed = output.length
      request.progress?.(read(output))
    }, PROGRESS_MS)
    watcher.unref()
    let outcome: Awaited<typeof spawned.done>
    try {
      outcome = await spawned.done
    } finally {
      clearInterval(watcher)
      clearTimeout(timer)
      clearTimeout(budgetTimer)
      request.signal.removeEventListener('abort', onAbort)
      rmSync(pidFile(attemptsDir, request.attemptId), { force: true })
    }
    const stdout = spawned.stdout()
    const parsed = parseAcp(stdout)
    if (codexAuth) keepRefreshedAuth(codexAuth)
    const log = (await artifacts.putBytes({
      kind: 'file', schemaVersion: 1, data: Buffer.from(stdout.slice(-MAX_LOG_BYTES)),
      mediaType: 'application/x-ndjson', classification: 'local-private',
      producer: { type: 'worker', ref: account.ref }, workId: request.workId, attemptId: request.attemptId,
    })).id
    const captured = await capture(artifacts, ws, request, account.ref)
    const common = { log, executor }
    if (request.signal.aborted) return { status: 'cancelled', outputs: {}, partial: captured.outputs, reason: 'cancelled; ACP child stopped', ...common }
    if (overBudget) return { status: 'failed', outputs: {}, partial: captured.outputs, reason: 'ACP attempt exceeded its configured minutes budget', ...common }
    if (timedOut) return { status: 'failed', outputs: {}, partial: captured.outputs, reason: `ACP attempt exceeded its ${limit} minute limit`, ...common }
    if (outcome.exitCode !== 0 || !parsed.ok) {
      return { status: 'failed', outputs: {}, partial: captured.outputs, reason: `${account.ref}: ${parsed.message}`, ...common }
    }
    if (captured.missing.length) return {
      status: 'failed', outputs: {}, partial: captured.outputs,
      reason: `${account.ref}: missing output ${captured.missing.join(', ')}`, ...common,
    }
    // ACP EndTurn is a transport result, not accepted Work: System still verifies.
    return { status: 'succeeded', outputs: captured.outputs, ...common }
  } finally {
    await cleanup(ws)
  }
}
