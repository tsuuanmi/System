/**
 * The `runtime-cli` row: registers each configured agent account whose CLI and
 * credential are present as a Worker; reports every account's state through
 * `ctx.agents` (`system workers`). Spawns through the DSH subprocess service. The `web` Accounts are the `runtime-web` row's (ADR-0018 decision 3).
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Artifacts } from '@system/artifacts/contract'
import type { Tier } from '@system/work'
import { TIERS, systemPath, z, tierCapability, type Capabilities } from '@system/work/contract'
import { agentWorker, type Account, type AttemptBudget } from './agent.ts'
import { chooseAsker } from './ask.ts'
import { adapterFor, checkSandbox } from './adapters/index.ts'
import type { SandboxOption } from './adapters/sandbox.ts'
import type { QuotaCache, QuotaReport } from './quota.ts'
import { RUNTIME_ABILITIES, type Runtime } from './runtimes.ts'
import { REGISTERING, SIGNED_OUT_REASON, type AccountRuntime, type AccountStatus, type AgentsService } from './service.ts'
import { lazyVersion, subprocessSpawner } from './spawner.ts'

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
export * from './service.ts'
export * from './spawner.ts'
export * from './workspace.ts'

export const name = 'system-runtime-cli'
export const inject = ['capabilities', 'artifacts', 'subprocess', 'credentials', 'storageDomain']

const windowSchema = z.object({ percentUsed: z.number(), resetsAt: z.string().optional() })
/** The last quota reading an attempt's `rate_limit_event`s gave, by account ref: read back after a Host restart (ro-7). */
export const agentsDomain = defineDomain({
  name: 'system_agents',
  version: 1,
  tables: { quota: domainTable(z.object({ observedAt: z.number(), windows: z.object({ five_hour: windowSchema.optional(), seven_day: windowSchema.optional() }) })) },
})


export interface AccountConfig {
  ref: string
  runtime: AccountRuntime
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
  /** How many attempts of this account run at once; overrides the row's. */
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
}

/** Optional composites default to `undefined`: Schemastery would otherwise fill an unset list or object with `[]`/`{}`, which `apply` reads as a value. */
const budgetSchema = Schema.object({ inputTokens: Schema.number(), minutes: Schema.number() }).default(undefined as never)
/** Types only: range and enum checks (tiers, runtimes, whole-number slots) stay in `apply`, whose messages name the account. */
const accountSchema = Schema.object({
  ref: Schema.string().required(),
  runtime: Schema.string().required(),
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
})
export const Config: Schema<Config> = Schema.object({
  attemptTimeoutMinutes: Schema.number(),
  maxConcurrentAttempts: Schema.number(),
  attemptBudget: budgetSchema,
  quotaCeilingPercent: Schema.number(),
  accounts: Schema.array(accountSchema).default([]),
  quota: Schema.object({ ttlMs: Schema.number(), now: Schema.function() }).default(undefined as never),
}) as Schema<Config>

/** The configured models in tier order; a tier that is not a tier is left for the registration to refuse. */
function modelsOf(models: AccountConfig['models']): Partial<Record<Tier, string>> {
  return Object.fromEntries(TIERS.filter((tier) => models?.[tier]).map((tier) => [tier, models![tier]]))
}


export async function apply(ctx: Context, config: Config): Promise<void> {
  const capabilities = ctx.get('capabilities')!
  const artifacts = ctx.get('artifacts') as Artifacts
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const credentials = ctx.get('credentials') as CredentialProvider
  const attempts = systemPath(ctx, 'attempts')
  const statuses: AccountStatus[] = []
  // The first registered ref of each provider account (runtime:id).
  const seen = new Map<string, string>()
  const versions = new Map<string, () => Promise<string>>()
  // Accounts whose last quota read failed with an authentication error, until a later read succeeds (authgate-1).
  const signedOut = new Set<string>()
  // The Account's view as its Runtime tells it: a refused or registering one included; its version is asked apart (`versions`).
  const statusOf = (status: AccountStatus): AccountStatus => {
    const reason = signedOut.has(status.ref) ? SIGNED_OUT_REASON : undefined
    return reason ? { ...status, available: false, reason } : { ...status }
  }
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
    if (status.reason === REGISTERING) return { unreadable: 'still registering' }
    return { unreadable: status.available ? `no quota reader for ${ref}` : `not registered: ${status.reason}` }
  }
  ctx.provide('agents', { ask } satisfies AgentsService)
  const dispose: (() => void)[] = []
  // Every account is listed from the start, as registering: the Host serves while this loop is still going (WW6e).
  const entries = (config.accounts ?? []).map((account) => {
    const status: AccountStatus = { ref: account.ref, runtime: account.runtime, abilities: [...(RUNTIME_ABILITIES as Record<string, readonly string[]>)[account.runtime] ?? []], capabilities: account.capabilities, models: modelsOf(account.models), ...(account.label ? { label: account.label } : {}), ...(account.priority !== undefined ? { note: 'priority is ignored: routing goes by quota headroom' } : {}), available: false, reason: REGISTERING }
    statuses.push(status)
    // Listed from the start: `system workers` shows the accounts still registering, and one that is refused; its Worker, once registered, supplies the same view.
    dispose.push(capabilities.registerListing({ ref: account.ref, status: () => statusOf(status), quota: (fresh) => quota(account.ref, { fresh }), version: async () => (await versions.get(account.ref)?.()) as string }))
    return { account, status }
  })
  const ceiling = config.quotaCeilingPercent
  if (ceiling !== undefined && !(typeof ceiling === 'number' && ceiling >= 1 && ceiling <= 100)) throw new Error(`quotaCeilingPercent is ${String(ceiling)}; it must be a number from 1 to 100`)
  // After the accounts are listed (as registering), which `system workers` serves while this awaits. Optional: a bare context (a test's) keeps no readings across a restart.
  const domain = await (ctx.get('storageDomain') as DomainFacility | undefined)?.open(agentsDomain)
  if (domain) ctx.effect(() => () => { void domain.close() }, 'system_agents domain')
  const observations = domain?.table('quota')
  for (const { account, status } of entries) {
    try {
      const sandbox = checkSandbox(account.runtime, account.sandbox)
      const unknown = Object.keys(account.models ?? {}).filter((tier) => !(TIERS as readonly string[]).includes(tier))
      if (unknown.length) throw new Error(`unknown tier ${unknown.join(', ')}; tiers are ${TIERS.join(', ')}`)
      const tiers = TIERS.filter((tier) => account.models?.[tier])
      const slots = account.maxConcurrentAttempts ?? config.maxConcurrentAttempts
      if (slots !== undefined && !(Number.isInteger(slots) && slots >= 1)) throw new Error(`maxConcurrentAttempts is ${slots}; it must be a whole number of at least 1`)
      const offered = [...account.capabilities, ...tiers.map(tierCapability)]
      status.capabilities = offered
      const attemptTimeoutMinutes = account.attemptTimeoutMinutes ?? config.attemptTimeoutMinutes
      let askVersion: () => Promise<string>
      // A runtime with no adapter is refused here; the web Runtime's Accounts are the runtime-web row's.
      const adapter = adapterFor(account.runtime)
      if (!adapter) throw new Error((account.runtime as string) === 'web' ? 'a web Account belongs to the runtime-web row (docs/operations/accounts-and-workers.md)' : `unknown runtime ${account.runtime}`)
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
      dispose.push(capabilities.registerWorker({ ...agentWorker(resolved, artifacts, spawner, attempts), status: () => statusOf(status), version: askVersion }))
      resolvedAccounts.set(account.ref, resolved)
      dispose.push(() => { resolvedAccounts.delete(account.ref) })
      if (key) seen.set(key, account.ref)
      status.available = true
      status.reason = 'registered'
      versions.set(account.ref, askVersion)
    } catch (error) {
      status.reason = (error as Error).message
      quotas.delete(account.ref)
    }
  }
  ctx.effect(() => () => { for (const d of dispose) d() }, 'agent registrations')
}
