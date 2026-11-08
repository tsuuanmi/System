/** Optional DSH/Cordis plugin: ACP-capable agents as provider-neutral Workers. */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Artifacts } from '@system/artifacts'
import { systemPath, type Capabilities, type WorkerAccountStatus } from '@system/work'
import { lazyVersion, subprocessSpawner } from '@system/worker-execution'
import { acpWorker, type AcpAccount } from './worker.ts'

export * from './worker.ts'
export * from './protocol.ts'

export const name = 'system-worker-acp'
export const inject = ['capabilities', 'artifacts', 'subprocess']

export interface AccountConfig {
  ref: string
  capabilities: string[]
  /** Rust ACP v1 bridge executable, resolved on PATH unless absolute. */
  command?: string
  /** Installed external agent binary that implements ACP v1. */
  agentCommand: string
  /** Separate argv entries; shell strings are not interpreted. */
  agentArgs?: string[]
  /** Optional System credential reference forwarded to the ACP child. */
  tokenRef?: string
  /** Optional isolated Codex auth directory, relative to $DSH_HOME/system. */
  codexHome?: string
  attemptTimeoutMinutes?: number
  maxConcurrentAttempts?: number
  attemptBudget?: { minutes?: number; inputTokens?: number }
  /** Model tiers are not supported by the v1 bridge. */
  models?: Record<string, string>
}

export interface Config {
  accounts?: AccountConfig[]
  attemptTimeoutMinutes?: number
  maxConcurrentAttempts?: number
  attemptBudget?: { minutes?: number; inputTokens?: number }
}

export interface AcpWorkersService {
  accounts(): Promise<WorkerAccountStatus[]>
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const credentials = ctx.get('credentials' as never) as CredentialProvider | undefined
  const attemptsDir = systemPath(ctx, 'attempts')
  const statuses: WorkerAccountStatus[] = []
  const versions = new Map<string, () => Promise<string>>()
  const dispose: (() => void)[] = []

  for (const entry of config.accounts ?? []) {
    const status: WorkerAccountStatus = {
      ref: entry.ref, runtime: 'acp', capabilities: entry.capabilities,
      available: false, reason: '',
    }
    statuses.push(status)
    try {
      if (!entry.ref || !entry.agentCommand) throw new Error('acp account needs ref and agentCommand')
      if (!entry.capabilities?.length) throw new Error('acp account must advertise at least one capability')
      if (entry.models && Object.keys(entry.models).length) throw new Error('ACP v1 bridge cannot guarantee model tier selection')
      if (entry.tokenRef && entry.codexHome) throw new Error('choose tokenRef or codexHome, not both')
      if (entry.attemptBudget?.inputTokens !== undefined || config.attemptBudget?.inputTokens !== undefined) {
        throw new Error('ACP bridge has no token metering; inputTokens budget cannot be enforced')
      }
      const slots = entry.maxConcurrentAttempts ?? config.maxConcurrentAttempts
      if (slots !== undefined && !(Number.isInteger(slots) && slots >= 1)) throw new Error('maxConcurrentAttempts must be a positive integer')
      const limit = entry.attemptTimeoutMinutes ?? config.attemptTimeoutMinutes
      if (limit !== undefined && !(Number.isFinite(limit) && limit > 0)) throw new Error('attemptTimeoutMinutes must be positive')
      const budget = entry.attemptBudget ?? config.attemptBudget
      if (budget?.minutes !== undefined && !(Number.isFinite(budget.minutes) && budget.minutes > 0)) throw new Error('attemptBudget.minutes must be positive')

      const command = await subprocess.resolveExecutable(entry.command ?? 'system-acp-bridge')
      const agentCommand = await subprocess.resolveExecutable(entry.agentCommand)
      status.command = command
      const version = lazyVersion(subprocess, command)
      const resolved: AcpAccount = {
        ref: entry.ref, capabilities: entry.capabilities, command, agentCommand,
        agentArgs: entry.agentArgs ?? [], version,
        maxConcurrentAttempts: slots, attemptTimeoutMinutes: limit,
        attemptBudget: budget?.minutes === undefined ? undefined : { minutes: budget.minutes },
      }
      if (entry.tokenRef) {
        if (!credentials) throw new Error('credentials service is not mounted')
        const ref = credentialRef(entry.tokenRef)
        if (!(await credentials.describe(ref)).configured) throw new Error(`token ${ref} not configured`)
        resolved.token = async () => (await credentials.resolve(ref))?.value
      }
      if (entry.codexHome) {
        const home = entry.codexHome
        resolved.codexHome = isAbsolute(home) ? home : systemPath(ctx, home)
        if (!existsSync(join(resolved.codexHome, 'auth.json'))) throw new Error('Codex auth.json unavailable')
      }
      dispose.push(capabilities.registerWorker(acpWorker(resolved, artifacts, subprocessSpawner(subprocess), attemptsDir)))
      versions.set(entry.ref, version)
      status.available = true
      status.reason = 'registered'
    } catch (error) {
      status.reason = (error as Error).message
    }
  }

  const accounts = () => Promise.all(statuses.map(async (item) => {
    const version = versions.get(item.ref)
    return version ? { ...item, version: await version() } : { ...item }
  }))
  dispose.push(capabilities.registerWorkerStatusProvider(accounts))
  ctx.effect(() => () => { for (const release of dispose) release() }, 'ACP Worker registrations')
  ctx.provide('acpWorkers', { accounts } satisfies AcpWorkersService)
}
