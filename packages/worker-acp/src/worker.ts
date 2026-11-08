/** One optional, provider-neutral ACP WorkerPort using DSH subprocess + official SDK. */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Artifacts } from '@system/artifacts'
import type { WorkerPort, WorkerRequest, WorkerResult } from '@system/work'
import { capture, cleanup, goneFromPidFile, pidFile, prepare, prompt } from '@system/worker-execution'
import type { AcpRunner } from './transport.ts'

const DEFAULT_ATTEMPT_TIMEOUT_MINUTES = 60
const MAX_LOG_BYTES = 256 * 1024

export interface AcpAccount {
  ref: string
  capabilities: string[]
  agentCommand: string
  agentArgs: string[]
  version: () => Promise<string>
  token?: () => Promise<string | undefined>
  /** Explicit per-account variable -> stored secret; provider-neutral. */
  credentialEnv?: Record<string, () => Promise<string | undefined>>
  codexHome?: string
  maxConcurrentAttempts?: number
  attemptTimeoutMinutes?: number
  attemptBudget?: { minutes?: number }
}

const digest = (path: string) => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : ''

function keepRefreshedAuth(auth: { attempt: string; account: string; before: string }): void {
  if (!existsSync(auth.attempt) || digest(auth.attempt) === auth.before || digest(auth.account) !== auth.before) return
  const staged = join(dirname(auth.account), '.auth.json.' + process.pid)
  copyFileSync(auth.attempt, staged)
  renameSync(staged, auth.account)
}

export function acpWorker(account: AcpAccount, artifacts: Artifacts, runner: AcpRunner, attemptsDir: string): WorkerPort {
  return {
    ref: account.ref,
    capabilities: account.capabilities,
    maxConcurrentAttempts: account.maxConcurrentAttempts,
    gone: async (attemptId) => goneFromPidFile(attemptsDir, attemptId),
    run: (request) => attempt(account, artifacts, runner, attemptsDir, request),
  }
}

async function attempt(
  account: AcpAccount,
  artifacts: Artifacts,
  runner: AcpRunner,
  attemptsDir: string,
  request: WorkerRequest,
): Promise<WorkerResult> {
  const executor: NonNullable<WorkerResult['executor']> = {
    ref: account.ref,
    account: account.ref.split('/').slice(1).join('/') || account.ref,
    command: account.agentCommand,
    version: await account.version(),
  }
  const ws = await prepare(artifacts, request, join(attemptsDir, request.attemptId.replace(/[^a-z0-9-]/gi, '_')))
  let cleaned = true
  try {
    const text = prompt(ws, request)
    let token: string | undefined
    if (account.token) {
      token = await account.token()
      if (!token) return { status: 'failed', outputs: {}, reason: account.ref + ': account credential is unavailable', executor }
    }

    let codexHome: string | undefined
    let codexAuth: { attempt: string; account: string; before: string } | undefined
    if (account.codexHome) {
      codexHome = join(ws.root, 'codex-home')
      mkdirSync(codexHome, { mode: 0o700 })
      const source = join(account.codexHome, 'auth.json')
      if (!existsSync(source)) return { status: 'failed', outputs: {}, reason: account.ref + ': auth.json unavailable', executor }
      const attemptAuth = join(codexHome, 'auth.json')
      copyFileSync(source, attemptAuth)
      codexAuth = { attempt: attemptAuth, account: source, before: digest(source) }
    }

    // DSH scrubs ambient credentials; only explicit account secrets reach this
    // child. Unsupported/missing secrets fail before any ACP process is started.
    const env: NodeJS.ProcessEnv = { HOME: ws.home, TMPDIR: ws.home }
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
    if (codexHome) env.CODEX_HOME = codexHome
    for (const [envName, resolveSecret] of Object.entries(account.credentialEnv ?? {})) {
      const secret = await resolveSecret()
      if (!secret) {
        return { status: 'failed', outputs: {}, reason: account.ref + ': credential for ' + envName + ' is unavailable', executor }
      }
      env[envName] = secret
    }

    const limit = account.attemptTimeoutMinutes ?? DEFAULT_ATTEMPT_TIMEOUT_MINUTES
    const stop = new AbortController()
    let timedOut = false
    let overBudget = false
    const onAbort = () => stop.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    const timer = setTimeout(() => { timedOut = true; stop.abort() }, limit * 60_000)
    const budgetTimer = account.attemptBudget?.minutes === undefined ? undefined :
      setTimeout(() => { overBudget = true; stop.abort() }, account.attemptBudget.minutes * 60_000)
    let result: Awaited<ReturnType<AcpRunner['run']>> | undefined
    let failed = false
    const stages: string[] = []
    try {
      result = await runner.run({
        command: account.agentCommand, args: account.agentArgs, cwd: ws.work, env,
        prompt: text, signal: stop.signal,
        pidFile: pidFile(attemptsDir, request.attemptId),
        onStage: (stage) => {
          if (stages.length < 64) stages.push(stage)
          request.progress?.({ stage: 'acp.' + stage })
        },
      })
    } catch {
      failed = true
    } finally {
      clearTimeout(timer)
      clearTimeout(budgetTimer)
      request.signal.removeEventListener('abort', onAbort)
    }

    // Do not reclaim an uncertain worktree while a subprocess may remain.
    cleaned = await goneFromPidFile(attemptsDir, request.attemptId)
    if (codexAuth && cleaned) keepRefreshedAuth(codexAuth)
    const logText = JSON.stringify({
      protocol: 'acp-v1', stages, stopReason: result?.stopReason ?? 'unknown',
      permissionDenied: result?.permissionDenied ?? false, transportFailed: failed,
    })
    const log = (await artifacts.putBytes({
      kind: 'file', schemaVersion: 1,
      data: Buffer.from(logText.slice(-MAX_LOG_BYTES)),
      mediaType: 'application/json', classification: 'local-private',
      producer: { type: 'worker', ref: account.ref },
      workId: request.workId, attemptId: request.attemptId,
    })).id
    const common = { log, executor }
    if (!cleaned) return {
      status: 'failed', outputs: {}, reason: account.ref + ': ACP subprocess exit is unconfirmed; attempt requires reconciliation',
      ...common,
    }
    const captured = await capture(artifacts, ws, request, account.ref)
    if (timedOut) return {
      status: 'failed', outputs: {}, partial: captured.outputs,
      reason: account.ref + ': ACP attempt timed out', ...common,
    }
    if (overBudget) return {
      status: 'failed', outputs: {}, partial: captured.outputs,
      reason: account.ref + ': ACP attempt exceeded its minutes budget', ...common,
    }
    if (request.signal.aborted) return {
      status: 'cancelled', outputs: {}, partial: captured.outputs, reason: 'ACP attempt cancelled', ...common,
    }
    if (failed || !result || result.stopReason !== 'end_turn' || result.exitCode !== 0 || result.permissionDenied) {
      return {
        status: 'failed', outputs: {}, partial: captured.outputs,
        reason: account.ref + ': ACP failed, declined permission or stopped without end_turn', ...common,
      }
    }
    if (captured.missing.length) return {
      status: 'failed', outputs: {}, partial: captured.outputs,
      reason: account.ref + ': missing output ' + captured.missing.join(', '), ...common,
    }
    return { status: 'succeeded', outputs: captured.outputs, ...common }
  } finally {
    if (cleaned) await cleanup(ws)
  }
}
