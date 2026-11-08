/**
 * The `agents` row: registers each configured agent account whose CLI and
 * credential are present as a Worker; reports every account's state through
 * `ctx.agents` (`system workers`). Spawns through the DSH subprocess service. A `chatgpt-web` account is served by
 * the optional `web-worker` row (see web.ts), or reported unavailable when it is off.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Artifacts } from '@system/artifacts'
import { TIERS, systemPath, tierCapability, type Capabilities, type Tier } from '@system/work'
import { DRAIN_MS, agentWorker, recordingPid, type Account, type AttemptBudget, type Spawner } from './agent.ts'
import type { Runtime } from './runtimes.ts'
import { WEB_WORKER_DISABLED, type WebAccountSettings, type WebWorkerService } from './web.ts'

export * from './agent.ts'
export * from './runtimes.ts'
export * from './web.ts'
export * from './workspace.ts'

export const name = 'system-agents'
export const inject = ['capabilities', 'artifacts', 'subprocess', 'credentials']

/** `chatgpt-web` is the web Runtime, served by the `web-worker` row. */
export type AccountRuntime = Runtime | 'chatgpt-web'

export interface AccountConfig extends WebAccountSettings {
  ref: string
  runtime: AccountRuntime
  capabilities: string[]
  /** The CLI to run; resolved on PATH unless absolute. */
  command?: string
  /** claude-code: the credential-store name of the account's token. */
  tokenRef?: string
  /** codex: CODEX_HOME, relative to $DSH_HOME/system unless absolute. */
  codexHome?: string
  /** The model per tier; each listed tier adds the capability `tier.<name>`. */
  models?: Partial<Record<Tier, string>>
  /** Wall-clock limit of one attempt, in minutes; overrides the row's. */
  attemptTimeoutMinutes?: number
  /** How many attempts of this account run at once; overrides the row's. A chatgpt-web account must leave it unset or 1. */
  maxConcurrentAttempts?: number
  /** What one attempt may spend (input tokens, minutes) before it is stopped as over budget; overrides the row's. */
  attemptBudget?: AttemptBudget
}

export interface Config {
  /** Wall-clock limit of one attempt, in minutes (fractions allowed); default 60. */
  attemptTimeoutMinutes?: number
  /** How many attempts of one account run at once (the Host's slots); default 1. */
  maxConcurrentAttempts?: number
  /** What one attempt may spend before it is stopped as over budget; default none. */
  attemptBudget?: AttemptBudget
  accounts?: AccountConfig[]
}

/** The reason of an account whose registration is not done yet. */
export const REGISTERING = 'registering'

export interface AccountStatus {
  ref: string
  runtime: AccountRuntime
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
        argv: recordingPid(spec), cwd: spec.cwd, env: spec.env, signal: spec.signal, graceMs: spec.graceMs,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      })
      return {
        // The agent's exit ends the attempt. Its range gets a bounded time to empty (and its output to arrive); what a leaked
        // process (an Xvfb of its own tests) still holds after that is terminated, never waited for: 33 min on 2026-11-07.
        done: handle.done.then(async (outcome) => {
          const drained = await handle.waitForExit(AbortSignal.timeout(spec.drainMs ?? DRAIN_MS)).catch(() => false)
          if (!drained) handle.terminate()
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
      try {
        const handle = subprocess.spawn({ argv: [command, '--version'], cwd: process.cwd(), graceMs: 2000, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
        await handle.done
        return (handle.collected.stdout?.readFrom(0).text ?? '').trim().split('\n')[0] ?? ''
      } catch {
        // A managed Chrome that is not installed yet has no version to report.
        return ''
      }
    })()
    return asked
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const credentials = ctx.get('credentials') as CredentialProvider
  // Optional: the web-worker row, listed before this one in the bundle; absent when it is disabled.
  const webWorker = ctx.get('webWorker') as WebWorkerService | undefined
  const attempts = systemPath(ctx, 'attempts')
  const statuses: AccountStatus[] = []
  const versions = new Map<string, () => Promise<string>>()
  // An account the web-worker row quarantines or cools down is unavailable, with what to do, until it is ready again.
  const unavailable = new Map<string, () => string | undefined>()
  const accounts = () => Promise.all(statuses.map(async (status) => {
    const askVersion = versions.get(status.ref)
    const reason = unavailable.get(status.ref)?.()
    if (reason) return { ...status, available: false, reason, ...(askVersion ? { version: await askVersion() } : {}) }
    return askVersion ? { ...status, version: await askVersion() } : { ...status }
  }))
  // Provided before the loop: `system workers` shows the accounts still registering.
  ctx.provide('agents', { accounts } satisfies AgentsService)
  const dispose: (() => void)[] = []
  // Every account is listed from the start, as registering: the Host serves while this loop is still going (WW6e).
  const entries = (config.accounts ?? []).map((account) => {
    const status: AccountStatus = { ref: account.ref, runtime: account.runtime, capabilities: account.capabilities, available: false, reason: REGISTERING }
    statuses.push(status)
    return { account, status }
  })
  // A web account's operations wait for its turn in the loop below; its registration ends with the entry's outcome.
  const outcomes = new Map<string, { done(): void; refuse(error: Error): void }>()
  for (const { account } of entries) {
    if (account.runtime !== 'chatgpt-web' || !webWorker) continue
    const done = new Promise<void>((resolve, refuse) => outcomes.set(account.ref, { done: resolve, refuse }))
    done.catch(() => {})
    webWorker.expect(account.ref, done)
  }
  for (const { account, status } of entries) {
    try {
      if (account.runtime === 'chatgpt-web' && !webWorker) throw new Error(WEB_WORKER_DISABLED)
      const unknown = Object.keys(account.models ?? {}).filter((tier) => !(TIERS as readonly string[]).includes(tier))
      if (unknown.length) throw new Error(`unknown tier ${unknown.join(', ')}; tiers are ${TIERS.join(', ')}`)
      const tiers = TIERS.filter((tier) => account.models?.[tier])
      // A web account is one Chrome profile: one attempt at a time, whatever the row says.
      const web = account.runtime === 'chatgpt-web'
      if (web && account.maxConcurrentAttempts !== undefined && account.maxConcurrentAttempts !== 1) throw new Error('a chatgpt-web account runs one attempt at a time (one Chrome profile); maxConcurrentAttempts must be 1')
      const slots = web ? 1 : account.maxConcurrentAttempts ?? config.maxConcurrentAttempts
      if (slots !== undefined && !(Number.isInteger(slots) && slots >= 1)) throw new Error(`maxConcurrentAttempts is ${slots}; it must be a whole number of at least 1`)
      const offered = [...account.capabilities, ...tiers.map(tierCapability)]
      status.capabilities = offered
      const attemptTimeoutMinutes = account.attemptTimeoutMinutes ?? config.attemptTimeoutMinutes
      let askVersion: () => Promise<string>
      if (account.runtime === 'chatgpt-web') {
        // The web-worker row checks the account, registers its Worker and owns its sign-in.
        const registered = await webWorker!.register({ ...account, capabilities: offered, attemptTimeoutMinutes, maxConcurrentAttempts: slots })
        status.command = registered.command
        askVersion = registered.version
        unavailable.set(account.ref, registered.unavailable)
        dispose.push(registered.dispose)
      } else {
        const command = await subprocess.resolveExecutable(account.command ?? (account.runtime === 'claude-code' ? 'claude' : 'codex'))
        status.command = command
        askVersion = lazyVersion(subprocess, command)
        const resolved: Account = { ref: account.ref, runtime: account.runtime, capabilities: offered, command, version: askVersion, models: account.models, attemptTimeoutMinutes, attemptBudget: account.attemptBudget ?? config.attemptBudget, maxConcurrentAttempts: slots }
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
      }
      status.available = true
      status.reason = 'registered'
      versions.set(account.ref, askVersion)
      outcomes.get(account.ref)?.done()
    } catch (error) {
      status.reason = (error as Error).message
      outcomes.get(account.ref)?.refuse(error as Error)
    }
  }
  ctx.effect(() => () => { for (const d of dispose) d() }, 'agent registrations')
}
