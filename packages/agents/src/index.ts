/**
 * The `agents` row: registers each configured agent account whose CLI and
 * credential are present as a Worker; reports every account's state through
 * `ctx.agents` (`system workers`). Spawns through the DSH subprocess service. A `web` account is served by
 * the optional `web-worker` row (see web.ts), or reported unavailable when it is off.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Artifacts } from '@system/artifacts'
import { TIERS, systemPath, z, tierCapability, type Capabilities, type Tier } from '@system/work'
import { DRAIN_MS, agentWorker, recordingPid, type Account, type AttemptBudget, type Spawner } from './agent.ts'
import { chooseAsker, type Ask } from './ask.ts'
import { adapterFor, checkSandbox } from './adapters/index.ts'
import type { SandboxOption } from './adapters/sandbox.ts'
import type { QuotaCache, QuotaReport } from './quota.ts'
import { RUNTIME_ABILITIES, type Runtime } from './runtimes.ts'
import { WEB_WORKER_DISABLED, isWebRuntime, webRefProblem, type WebAccountSettings, type WebWorkerService } from './web.ts'

export * from './adapters/index.ts'
export * from './agent.ts'
export * from './ask.ts'
export * from './attempt-summary.ts'
export * from './identity.ts'
export * from './lifecycle.ts'
export * from './node.ts'
export * from './quota.ts'
export * from './redact.ts'
export * from './runtimes.ts'
export * from './web.ts'
export * from './workspace.ts'

export const name = 'system-agents'
export const inject = ['capabilities', 'artifacts', 'subprocess', 'credentials', 'storageDomain']

const windowSchema = z.object({ percentUsed: z.number(), resetsAt: z.string().optional() })
/** The last quota reading an attempt's `rate_limit_event`s gave, by account ref: read back after a Host restart (ro-7). */
export const agentsDomain = defineDomain({
  name: 'system_agents',
  version: 1,
  tables: { quota: domainTable(z.object({ observedAt: z.number(), windows: z.object({ five_hour: windowSchema.optional(), seven_day: windowSchema.optional() }) })) },
})

/** `web` is the web Runtime, served by the `web-worker` row; its Site is the account's `site`. */
export type AccountRuntime = Runtime | 'web'

export interface AccountConfig extends WebAccountSettings {
  ref: string
  runtime: AccountRuntime
  /** web: the Site (`chatgpt`), which picks the shipped UI map and the defaults; the ref is `web/<site>/<name>`. */
  site?: string
  capabilities: string[]
  /** The CLI to run; resolved on PATH unless absolute. */
  command?: string
  /** claude-code: the credential-store name of the account's token. */
  tokenRef?: string
  /** Free text for people (an email, a name); shown in `system workers`. */
  label?: string
  /** Ignored since ro-7 (routing goes by quota headroom); `system workers` notes it. */
  priority?: unknown
  /** claude-code: the directory holding the account's `.claude.json` (its provider account ID), relative to $DSH_HOME/system unless absolute; default `claude/<name>`. */
  claudeHome?: string
  /** codex: CODEX_HOME, relative to $DSH_HOME/system unless absolute. */
  codexHome?: string
  /** antigravity: the Account's HOME (holds `.gemini/antigravity-cli` with its login), relative to $DSH_HOME/system unless absolute; default `antigravity/<name>`. */
  agyHome?: string
  /** antigravity: the model group the Account draws on and whose quota it reads: `gemini` (Gemini Models) or `3p` (Claude and GPT models). Required. */
  quotaGroup?: 'gemini' | '3p'
  /** The model per tier; each listed tier adds the capability `tier.<name>`. */
  models?: Partial<Record<Tier, string>>
  /** Wall-clock limit of one attempt, in minutes; overrides the row's. */
  attemptTimeoutMinutes?: number
  /** How many attempts of this account run at once; overrides the row's. A web account must leave it unset or 1. */
  maxConcurrentAttempts?: number
  /** What one attempt may spend (input tokens, minutes) before it is stopped as over budget; overrides the row's. */
  attemptBudget?: AttemptBudget
  /** Off by default: `true` runs the Runtime's process in one bubblewrap layer (adapters/sandbox.ts, ADR-0016); every CLI Runtime takes it. */
  sandbox?: SandboxOption
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
  /** How long the row waits for the web-worker row to provide its service, when that row is on but has not yet, in seconds (default 30). */
  webWorkerWaitSeconds?: number
}

/** Optional composites default to `undefined`: Schemastery would otherwise fill an unset list or object with `[]`/`{}`, which `apply` reads as a value. */
const budgetSchema = Schema.object({ inputTokens: Schema.number(), minutes: Schema.number() }).default(undefined as never)
/** Types only: range and enum checks (tiers, runtimes, whole-number slots) stay in `apply`, whose messages name the account. */
const accountSchema = Schema.object({
  ref: Schema.string().required(),
  runtime: Schema.string().required(),
  site: Schema.string(),
  capabilities: Schema.array(Schema.string()).required(),
  command: Schema.string(),
  tokenRef: Schema.string(),
  label: Schema.string(),
  priority: Schema.any(),
  claudeHome: Schema.string(),
  codexHome: Schema.string(),
  agyHome: Schema.string(),
  quotaGroup: Schema.string(),
  models: Schema.dict(Schema.string()).default(undefined as never),
  attemptTimeoutMinutes: Schema.number(),
  maxConcurrentAttempts: Schema.number(),
  attemptBudget: budgetSchema,
  sandbox: Schema.boolean(),
  profileDir: Schema.string(),
  temporaryChat: Schema.boolean(),
  url: Schema.string(),
  executablePath: Schema.string(),
  timeouts: Schema.dict(Schema.number()).default(undefined as never),
  maxOutsideChars: Schema.number(),
  cooldownSeconds: Schema.array(Schema.number()).default(undefined as never),
  hostLoad: Schema.number(),
})
export const Config: Schema<Config> = Schema.object({
  attemptTimeoutMinutes: Schema.number(),
  maxConcurrentAttempts: Schema.number(),
  attemptBudget: budgetSchema,
  quotaCeilingPercent: Schema.number(),
  accounts: Schema.array(accountSchema).default([]),
  quota: Schema.object({ ttlMs: Schema.number(), now: Schema.function() }).default(undefined as never),
  webWorkerWaitSeconds: Schema.number().default(30),
}) as Schema<Config>

/** The configured models in tier order; a tier that is not a tier is left for the registration to refuse. */
function modelsOf(models: AccountConfig['models']): Partial<Record<Tier, string>> {
  return Object.fromEntries(TIERS.filter((tier) => models?.[tier]).map((tier) => [tier, models![tier]]))
}

/** The reason of an account whose registration is not done yet. */
export const REGISTERING = 'registering'

export interface AccountStatus {
  ref: string
  runtime: AccountConfig['runtime']
  /** What its Runtime can do (declared in code, `RUNTIME_ABILITIES`); empty for a runtime that is refused. */
  abilities: string[]
  /** What the profile grants it: Roles and Tiers. */
  capabilities: string[]
  /** The model of each configured tier (never a credential). */
  models: Partial<Record<Tier, string>>
  /** What people call the account (free text). */
  label?: string
  /** Set when the profile still carries a field that is ignored. */
  note?: string
  /** The provider's own account ID (never a token); absent while unknown, and for a web account. */
  providerAccount?: string
  available: boolean
  reason: string
  command?: string
  version?: string
}

/** Why an Account whose quota read failed with an authentication error is unavailable. */
export const SIGNED_OUT_REASON = 'signed out'

export interface AgentsService {
  /** Every configured account; the CLI version of each available one is asked here, once. */
  accounts(): Promise<AccountStatus[]>
  /** The account's 5-hour and weekly quota, read without a model turn and cached for 10 minutes (`fresh` drops the cache and reads again); a Claude reading may come from the last attempt's rate-limit event when `get_usage` has no plan limits (`source`); `unreadable` for a `web` or unknown ref. */
  quota(ref: string, options?: { fresh?: boolean }): Promise<QuotaReport>
  /** One model turn with no tools on an economy-tier Account that is not in `exclude` (the Classifier's, cls-1); a refusal says why none could answer. Never throws. */
  ask: Ask
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

export async function apply(ctx: Context, config: Config): Promise<void> {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const credentials = ctx.get('credentials') as CredentialProvider
  // Optional: the web-worker row, listed before this one in the bundle; absent when it is disabled.
  let webWorker = ctx.get('webWorker') as WebWorkerService | undefined
  // Cordis applies rows that wait for the same services in no fixed order: the web-worker row, when it is on, may provide its service after this
  // row applies. Its accounts are then handed to it when it does (bounded), never reported "disabled" and left unannounced (flaky-2).
  const webWorkerComing = !webWorker && [...(ctx.registry?.values() ?? [])].some((runtime) => runtime.name === 'system-web-worker')
  const attempts = systemPath(ctx, 'attempts')
  const statuses: AccountStatus[] = []
  // The first registered ref of each provider account (runtime:id).
  const seen = new Map<string, string>()
  const versions = new Map<string, () => Promise<string>>()
  // An account the web-worker row quarantines or cools down is unavailable, with what to do, until it is ready again.
  const unavailable = new Map<string, () => string | undefined>()
  // Accounts whose last quota read failed with an authentication error, until a later read succeeds (authgate-1).
  const signedOut = new Set<string>()
  const accounts = () => Promise.all(statuses.map(async (status) => {
    const askVersion = versions.get(status.ref)
    const reason = unavailable.get(status.ref)?.() ?? (signedOut.has(status.ref) ? SIGNED_OUT_REASON : undefined)
    if (reason) return { ...status, available: false, reason, ...(askVersion ? { version: await askVersion() } : {}) }
    return askVersion ? { ...status, version: await askVersion() } : { ...status }
  }))
  const quotas = new Map<string, QuotaCache>()
  // The registered CLI Accounts, for `ask`.
  const resolvedAccounts = new Map<string, Account>()
  const spawner = subprocessSpawner(subprocess)
  const ask = chooseAsker(() => [...resolvedAccounts.values()], spawner, attempts)
  const quota = async (ref: string, options?: { fresh?: boolean }): Promise<QuotaReport> => {
    const cache = quotas.get(ref)
    if (cache) {
      if (options?.fresh) cache.invalidate()
      const report = await cache.get()
      if ('unreadable' in report && report.signedOut) signedOut.add(ref)
      else signedOut.delete(ref)
      return report
    }
    const status = statuses.find((s) => s.ref === ref)
    if (!status) return { unreadable: `no quota reader for ${ref}` }
    if (isWebRuntime(status.runtime)) return { unreadable: 'a web account has no quota reader' }
    if (status.reason === REGISTERING) return { unreadable: 'still registering' }
    return { unreadable: status.available ? `no quota reader for ${ref}` : `not registered: ${status.reason}` }
  }
  // Provided before the loop: `system workers` shows the accounts still registering.
  ctx.provide('agents', { accounts, quota, ask } satisfies AgentsService)
  const dispose: (() => void)[] = []
  // Every account is listed from the start, as registering: the Host serves while this loop is still going (WW6e).
  const entries = (config.accounts ?? []).map((account) => {
    const status: AccountStatus = { ref: account.ref, runtime: account.runtime, abilities: [...(RUNTIME_ABILITIES as Record<string, readonly string[]>)[account.runtime] ?? []], capabilities: account.capabilities, models: modelsOf(account.models), ...(account.label ? { label: account.label } : {}), ...(account.priority !== undefined ? { note: 'priority is ignored: routing goes by quota headroom' } : {}), available: false, reason: REGISTERING }
    statuses.push(status)
    return { account, status }
  })
  // A web account's operations wait for its turn in the loop below; its registration ends with the entry's outcome.
  const ceiling = config.quotaCeilingPercent
  if (ceiling !== undefined && !(typeof ceiling === 'number' && ceiling >= 1 && ceiling <= 100)) throw new Error(`quotaCeilingPercent is ${String(ceiling)}; it must be a number from 1 to 100`)
  let webWorkerLate: string | undefined
  if (webWorkerComing && entries.some(({ account }) => isWebRuntime(account.runtime))) {
    const seconds = config.webWorkerWaitSeconds ?? 30
    let timer: NodeJS.Timeout | undefined
    webWorker = await new Promise<WebWorkerService | undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), seconds * 1000)
      ctx.inject(['webWorker'], (inner) => { resolve(inner.get('webWorker') as WebWorkerService | undefined) })
    })
    clearTimeout(timer)
    if (!webWorker) webWorkerLate = `the web-worker row did not start within ${seconds} s`
  }
  const outcomes = new Map<string, { done(): void; refuse(error: Error): void }>()
  for (const { account } of entries) {
    if (!isWebRuntime(account.runtime) || webRefProblem(account) || !webWorker) continue
    const done = new Promise<void>((resolve, refuse) => outcomes.set(account.ref, { done: resolve, refuse }))
    done.catch(() => {})
    webWorker.expect(account.ref, done)
  }
  webWorker?.announced()
  // After the accounts are listed (as registering), which `system workers` serves while this awaits. Optional like `webWorker`: a bare context (a test's) keeps no readings across a restart.
  // Opening can fail: the announced accounts are then refused with that reason, never left pending until an operation's wait runs out (flaky-2).
  const domain = await (ctx.get('storageDomain') as DomainFacility | undefined)?.open(agentsDomain).catch((error: Error) => {
    for (const outcome of outcomes.values()) outcome.refuse(error)
    throw error
  })
  if (domain) ctx.effect(() => () => { void domain.close() }, 'system_agents domain')
  const observations = domain?.table('quota')
  for (const { account, status } of entries) {
    try {
      const sandbox = checkSandbox(account.runtime, account.sandbox)
      if (isWebRuntime(account.runtime)) {
        const problem = webRefProblem(account)
        if (problem) throw new Error(problem)
        if (!webWorker) throw new Error(webWorkerLate ?? WEB_WORKER_DISABLED)
      }
      const unknown = Object.keys(account.models ?? {}).filter((tier) => !(TIERS as readonly string[]).includes(tier))
      if (unknown.length) throw new Error(`unknown tier ${unknown.join(', ')}; tiers are ${TIERS.join(', ')}`)
      const tiers = TIERS.filter((tier) => account.models?.[tier])
      // A web account is one Chrome profile: one attempt at a time, whatever the row says.
      const web = isWebRuntime(account.runtime)
      if (web && account.maxConcurrentAttempts !== undefined && account.maxConcurrentAttempts !== 1) throw new Error('a web account runs one attempt at a time (one Chrome profile); maxConcurrentAttempts must be 1')
      const slots = web ? 1 : account.maxConcurrentAttempts ?? config.maxConcurrentAttempts
      if (slots !== undefined && !(Number.isInteger(slots) && slots >= 1)) throw new Error(`maxConcurrentAttempts is ${slots}; it must be a whole number of at least 1`)
      const offered = [...account.capabilities, ...tiers.map(tierCapability)]
      status.capabilities = offered
      const attemptTimeoutMinutes = account.attemptTimeoutMinutes ?? config.attemptTimeoutMinutes
      let askVersion: () => Promise<string>
      if (web) {
        // The web-worker row checks the account, registers its Worker and owns its sign-in.
        const registered = await webWorker!.register({ ...account, site: account.site!, capabilities: offered, abilities: status.abilities, attemptTimeoutMinutes, maxConcurrentAttempts: slots })
        status.command = registered.command
        status.capabilities = registered.capabilities ?? offered
        askVersion = registered.version
        unavailable.set(account.ref, registered.unavailable)
        dispose.push(registered.dispose)
      } else {
        // A runtime that is neither web nor a CLI with an adapter is refused here, with what the profile may name.
        const adapter = adapterFor(account.runtime)
        if (!adapter) throw new Error(`unknown runtime ${account.runtime}`)
        const command = await subprocess.resolveExecutable(account.command ?? adapter.defaultCommand)
        status.command = command
        askVersion = lazyVersion(subprocess, command)
        const resolved: Account = { ref: account.ref, runtime: account.runtime as Runtime, capabilities: [...new Set([...status.abilities, ...offered])], command, version: askVersion, models: account.models, attemptTimeoutMinutes, attemptBudget: account.attemptBudget ?? config.attemptBudget, ...(sandbox ? { sandbox } : {}), maxConcurrentAttempts: slots, quotaCeilingPercent: ceiling, quota: (fresh) => quota(account.ref, { fresh }) }
        // The adapter checks the credential and sets the Account's hooks; the provider's account ID comes from the account's own files: unknown leaves it registered; a known one registers once.
        const { quota: cache, providerAccount: id } = await adapter.register({ account, resolved, command, credentials, home: (relative) => systemPath(ctx, relative), quota: { ttlMs: config.quota?.ttlMs, now: config.quota?.now }, observations })
        quotas.set(account.ref, cache)
        const key = id && `${account.runtime}:${id}`
        if (id) status.providerAccount = id
        if (key && seen.has(key)) throw new Error(`provider account ${id} is already registered as ${seen.get(key)}; two refs on one account would count its quota twice`)
        dispose.push(capabilities.registerWorker(agentWorker(resolved, artifacts, spawner, attempts)))
        resolvedAccounts.set(account.ref, resolved)
        dispose.push(() => { resolvedAccounts.delete(account.ref) })
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
