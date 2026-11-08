/** Optional DSH/Cordis plugin: ACP-capable agents as provider-neutral Workers. */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Artifacts } from '@system/artifacts'
import { systemPath, type Capabilities, type WorkerAccountStatus } from '@system/work'
import { lazyVersion } from '@system/worker-execution'
import { dshAcpRunner } from './transport.ts'
import { acpWorker, type AcpAccount } from './worker.ts'

export * from './worker.ts'
export * from './transport.ts'

export const name = 'system-worker-acp'
export const inject = ['capabilities', 'artifacts', 'subprocess']

export interface AccountConfig {
  ref: string
  capabilities: string[]
  /** Installed external agent executable speaking stable ACP v1. */
  agentCommand: string
  /** Separate argv entries; shell strings are not interpreted. */
  agentArgs?: string[]
  /** Legacy Claude-specific secret; prefer envRefs for new providers. */
  tokenRef?: string
  /** Environment variable name -> System credential reference. Resolved only per Attempt. */
  envRefs?: Record<string, string>
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

/** No ambient shell/runtime settings can be overwritten by stored secrets. */
const FORBIDDEN_CREDENTIAL_ENV = new Set([
  'HOME', 'TMPDIR', 'TMP', 'TEMP', 'PATH', 'PWD', 'SHELL',
  'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'CODEX_HOME', 'CLAUDE_CODE_OAUTH_TOKEN',
])

export function validateCredentialEnv(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith('DSH_') ||
      name.startsWith('SYSTEM_') || FORBIDDEN_CREDENTIAL_ENV.has(name)) {
    throw new Error(`ACP envRefs: unsafe environment variable ${JSON.stringify(name)}`)
  }
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
  const runner = dshAcpRunner(subprocess)
  const seen = new Set<string>()

  for (const entry of config.accounts ?? []) {
    const status: WorkerAccountStatus = {
      ref: entry.ref, runtime: 'acp', capabilities: entry.capabilities,
      available: false, reason: '',
    }
    statuses.push(status)
    try {
      if (!entry.ref || !entry.agentCommand) throw new Error('acp account needs ref and agentCommand')
      if (seen.has(entry.ref) || capabilities.workerFor(entry.ref)) throw new Error(`duplicate Worker ref: ${entry.ref}`)
      seen.add(entry.ref)
      if (!Array.isArray(entry.agentArgs ?? []) || !(entry.agentArgs ?? []).every((arg) => typeof arg === 'string')) {
        throw new Error('agentArgs must be an array of strings')
      }
      if (entry.capabilities?.some((capability) => capability.startsWith('tier.'))) {
        throw new Error('ACP v1 does not guarantee tier capabilities; remove tier.* from the account')
      }
      if ('command' in entry) throw new Error('ACP no longer needs a Rust bridge command; remove command from the account')
      if (!entry.capabilities?.length) throw new Error('acp account must advertise at least one capability')
      if (entry.models && Object.keys(entry.models).length) throw new Error('ACP plugin cannot guarantee model tier selection')
      if (entry.tokenRef && entry.codexHome) throw new Error('choose tokenRef or codexHome, not both')
      if (entry.attemptBudget?.inputTokens !== undefined || config.attemptBudget?.inputTokens !== undefined) {
        throw new Error('ACP adapter has no token metering; inputTokens budget cannot be enforced')
      }
      const slots = entry.maxConcurrentAttempts ?? config.maxConcurrentAttempts
      if (slots !== undefined && !(Number.isInteger(slots) && slots >= 1)) throw new Error('maxConcurrentAttempts must be a positive integer')
      const limit = entry.attemptTimeoutMinutes ?? config.attemptTimeoutMinutes
      if (limit !== undefined && !(Number.isFinite(limit) && limit > 0)) throw new Error('attemptTimeoutMinutes must be positive')
      const budget = entry.attemptBudget ?? config.attemptBudget
      if (budget?.minutes !== undefined && !(Number.isFinite(budget.minutes) && budget.minutes > 0)) throw new Error('attemptBudget.minutes must be positive')

      const agentCommand = await subprocess.resolveExecutable(entry.agentCommand)
      status.command = agentCommand
      const version = lazyVersion(subprocess, agentCommand)
      const resolved: AcpAccount = {
        ref: entry.ref, capabilities: entry.capabilities, agentCommand,
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
      for (const [envName, secretName] of Object.entries(entry.envRefs ?? {})) {
        validateCredentialEnv(envName)
        if (!credentials) throw new Error('credentials service is not mounted')
        if (!secretName || typeof secretName !== 'string') throw new Error(`envRefs.${envName}: expected credential reference`)
        const ref = credentialRef(secretName)
        if (!(await credentials.describe(ref)).configured) throw new Error(`credential ${ref} for ${envName} is not configured`)
        resolved.credentialEnv ??= {}
        resolved.credentialEnv[envName] = async () => (await credentials.resolve(ref))?.value
      }
      if (entry.codexHome) {
        const home = entry.codexHome
        resolved.codexHome = isAbsolute(home) ? home : systemPath(ctx, home)
        if (!existsSync(join(resolved.codexHome, 'auth.json'))) throw new Error('Codex auth.json unavailable')
      }
      dispose.push(capabilities.registerWorker(acpWorker(resolved, artifacts, runner, attemptsDir)))
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
