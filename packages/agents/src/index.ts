/**
 * The `agents` row: registers each configured agent account whose CLI and
 * credential are present as a Worker; reports every account's state through
 * `ctx.agents` (`system workers`). Spawns through the DSH subprocess service.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Artifacts } from '@system/artifacts'
import { TIERS, systemPath, tierCapability, type Capabilities, type Tier } from '@system/work'
import { agentWorker, type Account, type Spawner } from './agent.ts'
import type { Runtime } from './runtimes.ts'

export * from './agent.ts'
export * from './runtimes.ts'
export * from './workspace.ts'

export const name = 'system-agents'
export const inject = ['capabilities', 'artifacts', 'subprocess', 'credentials']

export interface AccountConfig {
  ref: string
  runtime: Runtime
  capabilities: string[]
  /** The CLI to run; resolved on PATH unless absolute. */
  command?: string
  /** claude-code: the credential-store name of the account's token. */
  tokenRef?: string
  /** codex: CODEX_HOME, relative to $DSH_HOME/system unless absolute. */
  codexHome?: string
  /** The model per tier; each listed tier adds the capability `tier.<name>`. */
  models?: Partial<Record<Tier, string>>
}

export interface Config {
  accounts?: AccountConfig[]
}

export interface AccountStatus {
  ref: string
  runtime: Runtime
  capabilities: string[]
  available: boolean
  reason: string
  command?: string
  version?: string
}

export interface AgentsService {
  /** Every configured account; the CLI version of each available one is asked here, once. */
  accounts(): Promise<AccountStatus[]>
}

/** A `Spawner` over the DSH subprocess service, which owns each process range. */
export function subprocessSpawner(subprocess: SubprocessRuntime): Spawner {
  return {
    spawn(spec) {
      const handle = subprocess.spawn({
        argv: spec.argv, cwd: spec.cwd, env: spec.env, signal: spec.signal, graceMs: spec.graceMs,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      })
      return {
        // Settle only once the whole process range is gone, not just the direct child.
        done: handle.done.then(async (outcome) => {
          await handle.waitForExit().catch(() => false)
          return { exitCode: outcome.exitCode, signal: outcome.signal }
        }),
        stdout: () => handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: () => handle.collected.stderr?.readFrom(0).text ?? '',
      }
    },
  }
}

/** `<command> --version`, spawned once, on first use: startup spawns nothing. */
export function lazyVersion(subprocess: SubprocessRuntime, command: string): () => Promise<string> {
  let asked: Promise<string> | undefined
  return () => {
    asked ??= (async () => {
      const handle = subprocess.spawn({ argv: [command, '--version'], cwd: process.cwd(), graceMs: 2000, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
      await handle.done
      return (handle.collected.stdout?.readFrom(0).text ?? '').trim().split('\n')[0] ?? ''
    })()
    return asked
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const credentials = ctx.get('credentials') as CredentialProvider
  const attempts = systemPath(ctx, 'attempts')
  const statuses: AccountStatus[] = []
  const versions = new Map<string, () => Promise<string>>()
  const dispose: (() => void)[] = []
  for (const account of config.accounts ?? []) {
    const status: AccountStatus = { ref: account.ref, runtime: account.runtime, capabilities: account.capabilities, available: false, reason: '' }
    statuses.push(status)
    try {
      const command = await subprocess.resolveExecutable(account.command ?? (account.runtime === 'claude-code' ? 'claude' : 'codex'))
      status.command = command
      const askVersion = lazyVersion(subprocess, command)
      const unknown = Object.keys(account.models ?? {}).filter((tier) => !(TIERS as readonly string[]).includes(tier))
      if (unknown.length) throw new Error(`unknown tier ${unknown.join(', ')}; tiers are ${TIERS.join(', ')}`)
      const tiers = TIERS.filter((tier) => account.models?.[tier])
      const offered = [...account.capabilities, ...tiers.map(tierCapability)]
      status.capabilities = offered
      const resolved: Account = { ref: account.ref, runtime: account.runtime, capabilities: offered, command, version: askVersion, models: account.models }
      if (account.runtime === 'claude-code') {
        const ref = credentialRef(account.tokenRef ?? 'CLAUDE_CODE_OAUTH_TOKEN')
        if (!(await credentials.describe(ref)).configured) throw new Error(`token ${ref} is not configured (system credentials set ${ref})`)
        resolved.token = async () => (await credentials.resolve(ref))?.value
      } else {
        const home = account.codexHome ?? `codex/${account.ref.split('/')[1] ?? 'default'}`
        resolved.codexHome = isAbsolute(home) ? home : systemPath(ctx, home)
        if (!existsSync(join(resolved.codexHome, 'auth.json'))) throw new Error(`no auth.json in ${resolved.codexHome} (CODEX_HOME=${resolved.codexHome} codex login --device-auth)`)
      }
      dispose.push(capabilities.registerWorker(agentWorker(resolved, artifacts, subprocessSpawner(subprocess), attempts)))
      status.available = true
      status.reason = 'registered'
      versions.set(account.ref, askVersion)
    } catch (error) {
      status.reason = (error as Error).message
    }
  }
  ctx.effect(() => () => { for (const d of dispose) d() }, 'agent registrations')
  const accounts = () => Promise.all(statuses.map(async (status) => {
    const askVersion = versions.get(status.ref)
    return askVersion ? { ...status, version: await askVersion() } : { ...status }
  }))
  ctx.provide('agents', { accounts } satisfies AgentsService)
}
