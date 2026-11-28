/**
 * The `runtime-web` row: the `web` Runtime (WW2a). It owns its Accounts in its own row's `config.accounts` (ADR-0018 decision 3), checks each, registers
 * its Worker (sign-in and recheck are the Worker's own, found by its ref) and lists it in the Worker registry; it reads no other Runtime's config.
 * With the row off nothing of this package is loaded and there are no `web` Accounts.
 */
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { shippedMap, shippedMapProblem } from '@system/web-driver'
import { RUNTIME_ABILITIES, lazyVersion } from '@system/runtime-cli/contract'
import type { Artifacts } from '@system/artifacts/contract'
import { systemPath, type Capabilities, type RemoteSignIn, type SignInReport, type SignInStep, type WorkerStatus } from '@system/work/contract'
import { SITES, offeredTiers, webDefaults, webWorker, type WebConfig } from './chatgpt.ts'
import { webLogin } from './chatgpt-login.ts'
import { discoverChrome } from './chrome.ts'
import { XVFB_MISSING, findXvfb } from './display.ts'
import { AccountHealth, HEALTH_DEFAULTS, unavailableReason, type HealthSettings } from './health.ts'
import { recheck, type RecheckReport } from './recheck.ts'
import { startRemoteLogin, type RemoteSession } from './remote-login.ts'

export * from './chatgpt.ts'
export * from './chatgpt-login.ts'
export * from './remote-login.ts'
export * from './display.ts'
export * from './health.ts'
export * from './recheck.ts'

export const name = 'system-runtime-web'
export const inject = ['capabilities', 'artifacts', 'subprocess']

/** The `web` settings of an Account entry; the row validates them and fills the defaults. */
export interface WebAccountSettings {
  /** The Chrome profile (the signed-in session), relative to $DSH_HOME/system unless absolute; default `web/<site>/<name>`. */
  profileDir?: string
  /** Open each attempt in a temporary chat (default true). */
  temporaryChat?: boolean
  /** The page to open (default https://chatgpt.com/). */
  url?: string
  /** The Chrome to drive; default `CHROME_PATH`, a system Chrome as new as the engine's Chromium, else the pinned Chrome for Testing, installed under $DSH_HOME/system/browsers on first use. */
  executablePath?: string
  /** Seconds per stage (`load`, `answer`, `launch`, `mode`, `attach`) and how long the answer's text must stay unchanged (`stable`). */
  timeouts?: Partial<Record<'load' | 'answer' | 'stable' | 'launch' | 'mode' | 'attach', number>>
  /** Characters (whitespace ignored) the answer may hold outside its output blocks (default 200); more fails the attempt, as an output may be cut short. */
  maxOutsideChars?: number
  /** Seconds an Account cools down after the 1st, 2nd... consecutive site error (default [120, 300]; the last repeats). */
  cooldownSeconds?: number[]
  /** The 1-minute load average above which the Host is busy, so a page timeout is not held against the Account (default twice the CPUs). */
  hostLoad?: number
}

export interface AccountConfig extends WebAccountSettings {
  /** `web/<site>/<name>`. */
  ref: string
  /** Always `web` when given: an entry moved from the old `agents` row keeps its line. */
  runtime?: string
  /** The Site (`chatgpt`), which picks the shipped UI map and the defaults. */
  site?: string
  capabilities: string[]
  /** Free text for people; shown in `system workers`. */
  label?: string
  /** Ignored since ro-7 (routing goes by quota headroom); `system workers` notes it. */
  priority?: unknown
  /** Wall-clock limit of one attempt, in minutes; overrides the row's. */
  attemptTimeoutMinutes?: number
  /** A web Account is one Chrome profile: unset or 1. */
  maxConcurrentAttempts?: number
}

export interface Config {
  /** Wall-clock limit of one attempt, in minutes (fractions allowed; default 60). */
  attemptTimeoutMinutes?: number
  accounts?: AccountConfig[]
}

const accountSchema = Schema.object({
  ref: Schema.string().required(),
  runtime: Schema.string(),
  site: Schema.string(),
  capabilities: Schema.array(Schema.string()).required(),
  label: Schema.string(),
  priority: Schema.any(),
  attemptTimeoutMinutes: Schema.number(),
  maxConcurrentAttempts: Schema.number(),
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
  accounts: Schema.array(accountSchema).default([]),
}) as Schema<Config>

/** Why a web Account's `runtime`, Site and ref do not fit, if they do not: its ref is `web/<site>/<name>`. */
export function accountProblem(account: Pick<AccountConfig, 'ref' | 'runtime' | 'site'>): string | undefined {
  if (account.runtime !== undefined && account.runtime !== 'web') return `runtime is ${account.runtime}; an Account of this row is a web Account (or leave runtime out)`
  if (!account.site) return 'a web account names its site (site: chatgpt)'
  const [runtime, site, name, ...rest] = account.ref.split('/')
  if (runtime !== 'web' || site !== account.site || !name || rest.length) return `the ref ${account.ref} does not match site ${account.site}: a web account is web/<site>/<name>, here web/${account.site}/<name>`
  return undefined
}

export function apply(ctx: Context, config: Config = {}): void {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const attempts = systemPath(ctx, 'attempts')
  const webs = new Map<string, { web: WebConfig; health: AccountHealth }>()
  // A notice of a state change goes to the Host's log.
  const log = (line: string) => { process.stderr.write(`system host: runtime-web: ${line}\n`) }
  const disposers = new Set<() => void>()
  const remotes = new Map<string, RemoteSession>()
  ctx.effect(() => () => { for (const dispose of [...disposers]) dispose() }, 'web worker registrations')
  ctx.effect(() => () => { for (const remote of remotes.values()) void remote.cancel() }, 'remote sign-ins')

  // The Account's registered state: its Chrome profile and health, or why it is not registered.
  const account = (ref: string): { web: WebConfig; health: AccountHealth } => {
    const found = webs.get(ref)
    if (found) return found
    throw new Error(`${ref} is not a registered web account${failed.has(ref) ? `: ${failed.get(ref)}` : ' (system workers)'}`)
  }
  // A registration that failed is remembered with its reason: an operation that comes after it is refused with that.
  const failed = new Map<string, string>()
  const login = async (ref: string, cookies: string | undefined): Promise<SignInReport> => webLogin(account(ref).web, { cookies, display: process.env.DISPLAY })
  const loginRemote = async (ref: string): Promise<RemoteSignIn> => {
    const { web } = account(ref)
    if (remotes.has(ref)) throw new Error(`a remote sign-in of ${ref} is already running: finish it, or cancel it (system workers login ${ref} --remote, then Ctrl-C)`)
    const session = await startRemoteLogin(web)
    remotes.set(ref, session)
    void session.done.then(() => { if (remotes.get(ref) === session) remotes.delete(ref) })
    return { url: session.url, port: session.port, ssh: session.ssh, expiresAt: session.expiresAt }
  }
  const recheckOf = async (ref: string): Promise<RecheckReport> => {
    const { web, health } = account(ref)
    return recheck(web, health)
  }
  const loginWait = async (ref: string, cancel: boolean): Promise<SignInReport> => {
    const session = remotes.get(ref)
    if (!session) throw new Error(`no remote sign-in of ${ref} is running`)
    if (cancel) await session.cancel()
    const report = await session.done
    // A successful sign-in does the recheck itself: the Account is ready again only when the checks pass.
    if (!report.signedIn) return report
    const checked = await recheckOf(ref)
    return checked.ready ? report : { ...report, signedIn: false, detail: `signed in, but ${checked.detail}` }
  }

  const register = (entry: AccountConfig) => {
    const problem = accountProblem(entry)
    if (problem) throw new Error(problem)
    // A map that did not load is the same for every account: they are unavailable with that one reason (WW6f).
    const mapProblem = shippedMapProblem()
    if (mapProblem) throw new Error(`the UI map did not load: ${mapProblem}`)
    if ('procedures' in entry) throw new Error('procedures was removed: the generic Procedures are the only path; delete the line')
    if ('headless' in entry) throw new Error('headless is not an option: System always runs the browser headed, on a private display')
    const site = entry.site!
    if (!(site in SITES)) throw new Error(`unknown site ${site}; the shipped sites are: ${Object.keys(SITES).join(', ')}`)
    if (entry.maxConcurrentAttempts !== undefined && entry.maxConcurrentAttempts !== 1) throw new Error('a web account runs one attempt at a time (one Chrome profile); maxConcurrentAttempts must be 1')
    const name = entry.ref.split('/')[2] ?? 'default'
    const system = systemPath(ctx)
    if (!findXvfb()) throw new Error(XVFB_MISSING)
    const browsers = systemPath(ctx, 'browsers')
    const command = discoverChrome(entry.executablePath, { managedDir: browsers }).path
    const profile = entry.profileDir ?? join(system, 'web', site, name)
    const defaults = webDefaults(isAbsolute(profile) ? profile : systemPath(ctx, profile), site)
    const web: WebConfig = {
      ...defaults, ...(entry.executablePath ? { executablePath: entry.executablePath } : {}), managedDir: browsers, temporaryChat: entry.temporaryChat ?? defaults.temporaryChat,
      url: entry.url ?? defaults.url, timeouts: { ...defaults.timeouts, ...entry.timeouts }, maxOutsideChars: entry.maxOutsideChars ?? defaults.maxOutsideChars,
    }
    new URL(web.url)
    for (const [stage, seconds] of Object.entries(web.timeouts)) {
      if (!(typeof seconds === 'number' && seconds > 0)) throw new Error(`timeouts.${stage} is ${seconds}; it must be a number of seconds above 0`)
    }
    if (!(Number.isInteger(web.maxOutsideChars) && web.maxOutsideChars >= 0)) throw new Error(`maxOutsideChars is ${web.maxOutsideChars}; it must be a whole number of characters, 0 or more`)
    const cooldownSeconds = entry.cooldownSeconds ?? HEALTH_DEFAULTS.cooldownSeconds
    if (!(Array.isArray(cooldownSeconds) && cooldownSeconds.length > 0 && cooldownSeconds.every((n) => typeof n === 'number' && n > 0))) throw new Error(`cooldownSeconds is ${JSON.stringify(cooldownSeconds)}; it must be a list of seconds above 0`)
    if (entry.hostLoad !== undefined && !(typeof entry.hostLoad === 'number' && entry.hostLoad > 0)) throw new Error(`hostLoad is ${entry.hostLoad}; it must be a load average above 0`)
    const attemptTimeoutMinutes = entry.attemptTimeoutMinutes ?? config.attemptTimeoutMinutes
    const healthSettings: HealthSettings = { cooldownSeconds, ...(entry.hostLoad === undefined ? {} : { hostLoad: entry.hostLoad }) }
    // The Account's state lives in its directory, beside the profile, and survives a restart.
    const health = new AccountHealth(web.profileDir, entry.ref, { log, settings: healthSettings })
    const version = lazyVersion(subprocess, command)
    const offered = [...new Set([...entry.capabilities, ...offeredTiers(shippedMap())])]
    const worker = webWorker({ ref: entry.ref, capabilities: [...new Set([...RUNTIME_ABILITIES.web, ...offered])], command, version, offered, attemptTimeoutMinutes, maxConcurrentAttempts: 1, web, health, healthSettings }, artifacts, attempts)
    // ADR-0018 decision 2: sign-in and recheck are the Worker's own, found by its ref.
    worker.signIn = (request: SignInStep) => request.step === 'login' ? login(entry.ref, request.cookies) : request.step === 'remote' ? loginRemote(entry.ref) : loginWait(entry.ref, request.cancel)
    worker.recheck = () => recheckOf(entry.ref)
    const off = capabilities.registerWorker(worker)
    const registered = { web, health }
    webs.set(entry.ref, registered)
    const dispose = () => {
      if (!disposers.delete(dispose)) return
      if (webs.get(entry.ref) === registered) webs.delete(entry.ref)
      off()
    }
    disposers.add(dispose)
    return { command, version, capabilities: offered, unavailable: () => unavailableReason(health) }
  }

  for (const entry of config.accounts ?? []) {
    // Listed whether or not it registers: `system workers` shows a refused Account with its reason; its Worker, once registered, supplies the same view.
    const status: WorkerStatus = {
      runtime: 'web', abilities: [...RUNTIME_ABILITIES.web], capabilities: entry.capabilities, models: {}, available: false, reason: 'registering',
      ...(entry.label ? { label: entry.label } : {}), ...(entry.priority !== undefined ? { note: 'priority is ignored: routing goes by quota headroom' } : {}),
    }
    let version: () => Promise<string> = async () => ''
    let unavailable: () => string | undefined = () => undefined
    disposers.add(capabilities.registerListing({ ref: entry.ref, status: () => ({ ...status, ...(unavailable() ? { available: false, reason: unavailable()! } : {}) }), quota: async () => ({ unreadable: 'a web account has no quota reader' }), version: () => version() }))
    try {
      const registered = register(entry)
      status.available = true
      status.reason = 'registered'
      status.command = registered.command
      status.capabilities = registered.capabilities
      version = registered.version
      unavailable = registered.unavailable
    } catch (error) {
      status.reason = (error as Error).message
      failed.set(entry.ref, status.reason)
    }
  }
}
