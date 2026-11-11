/**
 * The `agents` row: registers each configured agent account whose CLI and
 * credential are present as a Worker; reports every account's state through
 * `ctx.agents` (`system workers`). Spawns through the DSH subprocess service. A `web` account is served by
 * the optional `web-worker` row (see web.ts), or reported unavailable when it is off.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Artifacts } from '@system/artifacts'
import { TIERS, systemPath, tierCapability, type Capabilities, type Tier } from '@system/work'
import { DRAIN_MS, agentWorker, recordingPid, type Account, type AttemptBudget, type Spawner } from './agent.ts'
import { readClaudeAccountId, readCodexAccountId } from './identity.ts'
import { createQuotaCache, readClaudeQuota, readCodexQuota, type QuotaCache, type QuotaReport } from './quota.ts'
import type { Runtime } from './runtimes.ts'
import { WEB_WORKER_DISABLED, type WebAccountSettings, type WebWorkerService } from './web.ts'

export * from './agent.ts'
export * from './identity.ts'
export * from './quota.ts'
export * from './runtimes.ts'
export * from './web.ts'
export * from './workspace.ts'

export const name = 'system-agents'
export const inject = ['capabilities', 'artifacts', 'subprocess', 'credentials']

/** `web` is the web Runtime, served by the `web-worker` row; its Site is the account's `site`. */
export type AccountRuntime = Runtime | 'web'

/** The reason of an account that still names the Runtime as it was called before the Site was a setting of it. */
export const CHATGPT_WEB_RENAMED = 'the chatgpt-web runtime was renamed: use runtime: web, site: chatgpt, ref web/chatgpt/<name>'

/** What is wrong with a web account's Site and ref, if anything: its ref is `web/<site>/<name>`; the web-worker row knows which Sites ship. */
export function webRefProblem(account: { ref: string; site?: string }): string | undefined {
  if (!account.site) return 'a web account names its site (site: chatgpt)'
  const [runtime, site, name, ...rest] = account.ref.split('/')
  if (runtime !== 'web' || site !== account.site || !name || rest.length) return `the ref ${account.ref} does not match site ${account.site}: a web account is web/<site>/<name>, here web/${account.site}/<name>`
  return undefined
}

export interface AccountConfig extends WebAccountSettings {
  ref: string
  /** The Runtime; `chatgpt-web` is only read to be refused (CHATGPT_WEB_RENAMED). */
  runtime: AccountRuntime | 'chatgpt-web'
  /** web: the Site (`chatgpt`), which picks the shipped UI map and the defaults; the ref is `web/<site>/<name>`. */
  site?: string
  capabilities: string[]
  /** The CLI to run; resolved on PATH unless absolute. */
  command?: string
  /** claude-code: the credential-store name of the account's token. */
  tokenRef?: string
  /** Free text for people (an email, a name); shown in `system workers`. */
  label?: string
  /** `primary` marks the account to prefer; at most one account per Runtime. Omitted is secondary. */
  priority?: 'primary'
  /** claude-code: the directory holding the account's `.claude.json` (its provider account ID), relative to $DSH_HOME/system unless absolute; default `claude/<name>`. */
  claudeHome?: string
  /** codex: CODEX_HOME, relative to $DSH_HOME/system unless absolute. */
  codexHome?: string
  /** The model per tier; each listed tier adds the capability `tier.<name>`. */
  models?: Partial<Record<Tier, string>>
  /** Wall-clock limit of one attempt, in minutes; overrides the row's. */
  attemptTimeoutMinutes?: number
  /** How many attempts of this account run at once; overrides the row's. A web account must leave it unset or 1. */
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
  /** From this share of a quota window used (1-100, default 80) an account is not chosen while another is under it; when all are over, the step waits. */
  quotaCeilingPercent?: number
  accounts?: AccountConfig[]
  /** A test hook: the quota cache's lifetime (default 10 minutes) and clock. */
  quota?: { ttlMs?: number; now?: () => number }
}

/** The configured models in tier order; a tier that is not a tier is left for the registration to refuse. */
function modelsOf(models: AccountConfig['models']): Partial<Record<Tier, string>> {
  return Object.fromEntries(TIERS.filter((tier) => models?.[tier]).map((tier) => [tier, models![tier]]))
}

/** The reason of an account whose registration is not done yet. */
export const REGISTERING = 'registering'

export interface AccountStatus {
  ref: string
  runtime: AccountConfig['runtime']
  capabilities: string[]
  /** The model of each configured tier (never a credential). */
  models: Partial<Record<Tier, string>>
  /** What people call the account (free text). */
  label?: string
  priority: 'primary' | 'secondary'
  /** The provider's own account ID (never a token); absent while unknown, and for a web account. */
  providerAccount?: string
  available: boolean
  reason: string
  command?: string
  version?: string
}

export interface AgentsService {
  /** Every configured account; the CLI version of each available one is asked here, once. */
  accounts(): Promise<AccountStatus[]>
  /** The account's 5-hour and weekly quota, read without a model turn and cached for 10 minutes (`fresh` drops the cache and reads again); `unreadable` for a `web` or unknown ref. */
  quota(ref: string, options?: { fresh?: boolean }): Promise<QuotaReport>
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
  // The first registered ref of each provider account (runtime:id), and the ref holding each Runtime's primary.
  const seen = new Map<string, string>()
  const primaries = new Map<string, string>()
  const versions = new Map<string, () => Promise<string>>()
  // An account the web-worker row quarantines or cools down is unavailable, with what to do, until it is ready again.
  const unavailable = new Map<string, () => string | undefined>()
  const accounts = () => Promise.all(statuses.map(async (status) => {
    const askVersion = versions.get(status.ref)
    const reason = unavailable.get(status.ref)?.()
    if (reason) return { ...status, available: false, reason, ...(askVersion ? { version: await askVersion() } : {}) }
    return askVersion ? { ...status, version: await askVersion() } : { ...status }
  }))
  const quotas = new Map<string, QuotaCache>()
  const quota = async (ref: string, options?: { fresh?: boolean }): Promise<QuotaReport> => {
    const cache = quotas.get(ref)
    if (cache) {
      if (options?.fresh) cache.invalidate()
      return cache.get()
    }
    const status = statuses.find((s) => s.ref === ref)
    if (!status) return { unreadable: `no quota reader for ${ref}` }
    if (status.runtime === 'web') return { unreadable: 'a web account has no quota reader' }
    if (status.reason === REGISTERING) return { unreadable: 'still registering' }
    return { unreadable: status.available ? `no quota reader for ${ref}` : `not registered: ${status.reason}` }
  }
  // Provided before the loop: `system workers` shows the accounts still registering.
  ctx.provide('agents', { accounts, quota } satisfies AgentsService)
  const dispose: (() => void)[] = []
  // Every account is listed from the start, as registering: the Host serves while this loop is still going (WW6e).
  const entries = (config.accounts ?? []).map((account) => {
    const status: AccountStatus = { ref: account.ref, runtime: account.runtime, capabilities: account.capabilities, models: modelsOf(account.models), ...(account.label ? { label: account.label } : {}), priority: account.priority === 'primary' ? 'primary' : 'secondary', available: false, reason: REGISTERING }
    statuses.push(status)
    return { account, status }
  })
  // A web account's operations wait for its turn in the loop below; its registration ends with the entry's outcome.
  const ceiling = config.quotaCeilingPercent
  if (ceiling !== undefined && !(typeof ceiling === 'number' && ceiling >= 1 && ceiling <= 100)) throw new Error(`quotaCeilingPercent is ${String(ceiling)}; it must be a number from 1 to 100`)
  const outcomes = new Map<string, { done(): void; refuse(error: Error): void }>()
  for (const { account } of entries) {
    if (account.runtime !== 'web' || webRefProblem(account) || !webWorker) continue
    const done = new Promise<void>((resolve, refuse) => outcomes.set(account.ref, { done: resolve, refuse }))
    done.catch(() => {})
    webWorker.expect(account.ref, done)
  }
  for (const { account, status } of entries) {
    try {
      if (account.runtime === 'chatgpt-web') throw new Error(CHATGPT_WEB_RENAMED)
      if (account.runtime === 'web') {
        const problem = webRefProblem(account)
        if (problem) throw new Error(problem)
        if (!webWorker) throw new Error(WEB_WORKER_DISABLED)
      }
      if (account.priority !== undefined && (account.priority as string) !== 'primary') throw new Error('priority must be primary or omitted')
      if (account.priority === 'primary') {
        const held = primaries.get(account.runtime)
        if (held) throw new Error(`priority: primary is already held by ${held}; at most one account per Runtime may be primary`)
        primaries.set(account.runtime, account.ref)
      }
      const unknown = Object.keys(account.models ?? {}).filter((tier) => !(TIERS as readonly string[]).includes(tier))
      if (unknown.length) throw new Error(`unknown tier ${unknown.join(', ')}; tiers are ${TIERS.join(', ')}`)
      const tiers = TIERS.filter((tier) => account.models?.[tier])
      // A web account is one Chrome profile: one attempt at a time, whatever the row says.
      const web = account.runtime === 'web'
      if (web && account.maxConcurrentAttempts !== undefined && account.maxConcurrentAttempts !== 1) throw new Error('a web account runs one attempt at a time (one Chrome profile); maxConcurrentAttempts must be 1')
      const slots = web ? 1 : account.maxConcurrentAttempts ?? config.maxConcurrentAttempts
      if (slots !== undefined && !(Number.isInteger(slots) && slots >= 1)) throw new Error(`maxConcurrentAttempts is ${slots}; it must be a whole number of at least 1`)
      const offered = [...account.capabilities, ...tiers.map(tierCapability)]
      status.capabilities = offered
      const attemptTimeoutMinutes = account.attemptTimeoutMinutes ?? config.attemptTimeoutMinutes
      let askVersion: () => Promise<string>
      if (account.runtime === 'web') {
        // The web-worker row checks the account, registers its Worker and owns its sign-in.
        const registered = await webWorker!.register({ ...account, site: account.site!, capabilities: offered, attemptTimeoutMinutes, maxConcurrentAttempts: slots })
        status.command = registered.command
        status.capabilities = registered.capabilities ?? offered
        askVersion = registered.version
        unavailable.set(account.ref, registered.unavailable)
        dispose.push(registered.dispose)
      } else {
        const command = await subprocess.resolveExecutable(account.command ?? (account.runtime === 'claude-code' ? 'claude' : 'codex'))
        status.command = command
        askVersion = lazyVersion(subprocess, command)
        const resolved: Account = { ref: account.ref, runtime: account.runtime, capabilities: offered, command, version: askVersion, models: account.models, attemptTimeoutMinutes, attemptBudget: account.attemptBudget ?? config.attemptBudget, maxConcurrentAttempts: slots, priority: account.priority ?? 'secondary', quotaCeilingPercent: ceiling, quota: (fresh) => quota(account.ref, { fresh }) }
        if (account.runtime === 'claude-code') {
          const ref = credentialRef(account.tokenRef ?? 'CLAUDE_CODE_OAUTH_TOKEN')
          if (!(await credentials.describe(ref)).configured) throw new Error(`token ${ref} is not configured (system credentials set ${ref})`)
          resolved.token = async () => (await credentials.resolve(ref))?.value
        } else {
          const home = account.codexHome ?? `codex/${account.ref.split('/')[1] ?? 'default'}`
          resolved.codexHome = isAbsolute(home) ? home : systemPath(ctx, home)
          if (!existsSync(join(resolved.codexHome, 'auth.json'))) throw new Error(`no auth.json in ${resolved.codexHome} (CODEX_HOME=${resolved.codexHome} codex login --device-auth)`)
        }
        // The provider's account ID, read from the account's own files: unknown leaves it registered; a known one registers once.
        let id: string | undefined
        const quotaOptions = { ttlMs: config.quota?.ttlMs, now: config.quota?.now }
        if (account.runtime === 'claude-code') {
          const h = account.claudeHome ?? `claude/${account.ref.split('/')[1] ?? 'default'}`
          const claudeHome = isAbsolute(h) ? h : systemPath(ctx, h)
          // The row owns this home: create it (mode 700) so the quota reader's cwd exists. A failure leaves the account registered; the quota reason names the directory.
          try { mkdirSync(claudeHome, { recursive: true, mode: 0o700 }) } catch { /* reported by the quota read */ }
          id = readClaudeAccountId(claudeHome)
          const cache = createQuotaCache({
            ...quotaOptions,
            read: async () => {
              const token = await resolved.token?.()
              return token ? readClaudeQuota({ command, home: claudeHome, token, now: quotaOptions.now }) : { unreadable: 'its token is not configured' }
            },
          })
          resolved.onRateLimit = (events) => cache.observe(events)
          quotas.set(account.ref, cache)
        } else {
          const codexHome = resolved.codexHome!
          quotas.set(account.ref, createQuotaCache({ ...quotaOptions, read: () => readCodexQuota({ command, codexHome, now: quotaOptions.now }) }))
          id = readCodexAccountId(codexHome)
        }
        const key = id && `${account.runtime}:${id}`
        if (id) status.providerAccount = id
        if (key && seen.has(key)) throw new Error(`provider account ${id} is already registered as ${seen.get(key)}; two refs on one account would count its quota twice`)
        dispose.push(capabilities.registerWorker(agentWorker(resolved, artifacts, subprocessSpawner(subprocess), attempts)))
        if (key) seen.set(key, account.ref)
      }
      status.available = true
      status.reason = 'registered'
      versions.set(account.ref, askVersion)
      outcomes.get(account.ref)?.done()
    } catch (error) {
      status.reason = (error as Error).message
      quotas.delete(account.ref)
      outcomes.get(account.ref)?.refuse(error as Error)
    }
  }
  ctx.effect(() => () => { for (const d of dispose) d() }, 'agent registrations')
}
