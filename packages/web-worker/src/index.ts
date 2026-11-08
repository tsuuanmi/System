/**
 * The `web-worker` row: the `chatgpt-web` Runtime as its own, optional row (WW2a). It registers the `chatgpt-web`
 * accounts the `agents` row hands it as Workers and owns their sign-in (`ctx.webWorker`: cookie import, a window,
 * the remote viewer). With the row off nothing of this package is loaded and those accounts are unavailable.
 */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { shippedMap, shippedMapProblem } from '@system/web-driver'
import { lazyVersion, type RecheckReport, type RemoteView, type WebRegistration, type WebWorkerService } from '@system/agents'
import type { Artifacts } from '@system/artifacts'
import { systemPath, type Capabilities } from '@system/work'
import { checkProcedures, offeredTiers, webDefaults, webWorker, type WebConfig } from './chatgpt.ts'
import { webLogin } from './chatgpt-login.ts'
import { discoverChrome } from './chrome.ts'
import { XVFB_MISSING, findXvfb } from './display.ts'
import { AccountHealth, HEALTH_DEFAULTS, unavailableReason, type HealthSettings } from './health.ts'
import { recheck } from './recheck.ts'
import { startRemoteLogin, type RemoteSession } from './remote-login.ts'

export * from './chatgpt.ts'
export * from './chatgpt-login.ts'
export * from './remote-login.ts'
export * from './display.ts'
export * from './health.ts'
export * from './recheck.ts'

export const name = 'system-web-worker'
export const inject = ['capabilities', 'artifacts', 'subprocess']

export interface Config {
  /** How long an operation on an account waits for its registration in progress, in seconds (default 60). */
  registerWaitSeconds?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const attempts = systemPath(ctx, 'attempts')
  const webs = new Map<string, { web: WebConfig; health: AccountHealth }>()
  // A notice of a state change goes to the Host's log.
  const log = (line: string) => { process.stderr.write(`system host: web-worker: ${line}\n`) }
  const disposers = new Set<() => void>()
  const register = async (account: WebRegistration) => {
    // A map that did not load is the same for every account: they are unavailable with that one reason (WW6f).
    const mapProblem = shippedMapProblem()
    if (mapProblem) throw new Error(`the ChatGPT UI map did not load: ${mapProblem}`)
    if ('headless' in account) throw new Error('headless is not an option: System always runs the browser headed, on a private display')
    if (!findXvfb()) throw new Error(XVFB_MISSING)
    const browsers = systemPath(ctx, 'browsers')
    const command = discoverChrome(account.executablePath, { managedDir: browsers }).path
    const profile = account.profileDir ?? `chatgpt-web/${account.ref.split('/')[1] ?? 'default'}`
    const defaults = webDefaults(isAbsolute(profile) ? profile : systemPath(ctx, profile))
    const web: WebConfig = {
      ...defaults, ...(account.executablePath ? { executablePath: account.executablePath } : {}), managedDir: browsers, temporaryChat: account.temporaryChat ?? defaults.temporaryChat,
      url: account.url ?? defaults.url, timeouts: { ...defaults.timeouts, ...account.timeouts }, maxOutsideChars: account.maxOutsideChars ?? defaults.maxOutsideChars,
      procedures: checkProcedures(account.procedures),
    }
    new URL(web.url)
    for (const [stage, seconds] of Object.entries(web.timeouts)) {
      if (!(typeof seconds === 'number' && seconds > 0)) throw new Error(`timeouts.${stage} is ${seconds}; it must be a number of seconds above 0`)
    }
    if (!(Number.isInteger(web.maxOutsideChars) && web.maxOutsideChars >= 0)) throw new Error(`maxOutsideChars is ${web.maxOutsideChars}; it must be a whole number of characters, 0 or more`)
    const cooldownSeconds = account.cooldownSeconds ?? HEALTH_DEFAULTS.cooldownSeconds
    if (!(Array.isArray(cooldownSeconds) && cooldownSeconds.length > 0 && cooldownSeconds.every((n) => typeof n === 'number' && n > 0))) throw new Error(`cooldownSeconds is ${JSON.stringify(cooldownSeconds)}; it must be a list of seconds above 0`)
    if (account.hostLoad !== undefined && !(typeof account.hostLoad === 'number' && account.hostLoad > 0)) throw new Error(`hostLoad is ${account.hostLoad}; it must be a load average above 0`)
    const healthSettings: HealthSettings = { cooldownSeconds, ...(account.hostLoad === undefined ? {} : { hostLoad: account.hostLoad }) }
    // The Account's state lives in its directory, beside the profile, and survives a restart.
    const health = new AccountHealth(web.profileDir, account.ref, { log, settings: healthSettings })
    const version = lazyVersion(subprocess, command)
    const offered = [...new Set([...account.capabilities, ...offeredTiers(web, shippedMap())])]
    const off = capabilities.registerWorker(webWorker({ ref: account.ref, capabilities: offered, command, version, attemptTimeoutMinutes: account.attemptTimeoutMinutes, maxConcurrentAttempts: account.maxConcurrentAttempts, web, health, healthSettings }, artifacts, attempts))
    const entry = { web, health }
    webs.set(account.ref, entry)
    const dispose = () => {
      if (!disposers.delete(dispose)) return
      if (webs.get(account.ref) === entry) webs.delete(account.ref)
      off()
    }
    disposers.add(dispose)
    return { command, version, capabilities: offered, dispose, unavailable: () => unavailableReason(health) }
  }
  ctx.effect(() => () => { for (const dispose of [...disposers]) dispose() }, 'web worker registrations')
  const remotes = new Map<string, RemoteSession>()
  ctx.effect(() => () => { for (const remote of remotes.values()) void remote.cancel() }, 'remote sign-ins')
  // WW6e: the Host reports "started" before the `agents` row has handed every account over, so an account the row has
  // announced (`expect`) but not registered yet is waited for, bounded; only one never announced is "not configured".
  const pending = new Map<string, Promise<unknown>>()
  // A registration that failed is remembered with its reason: an operation that comes after it is refused with that, never as "not configured".
  const failed = new Map<string, string>()
  const expect = (ref: string, done: Promise<unknown>) => {
    failed.delete(ref)
    const entry = done.finally(() => { if (pending.get(ref) === entry) pending.delete(ref) })
    pending.set(ref, entry)
    entry.catch((error: Error) => { failed.set(ref, error.message) })
  }
  const waitSeconds = config.registerWaitSeconds ?? 60
  const account = async (ref: string): Promise<{ web: WebConfig; health: AccountHealth }> => {
    const waiting = pending.get(ref)
    if (waiting) {
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${ref} is still registering after ${waitSeconds} s (system workers)`)), waitSeconds * 1000) })
      try {
        await Promise.race([waiting, late])
      } catch (error) {
        throw (error as Error).message.startsWith(`${ref} is still registering`) ? error : new Error(`${ref}: ${(error as Error).message}`)
      } finally {
        clearTimeout(timer)
      }
    }
    const found = webs.get(ref)
    if (!found && failed.has(ref)) throw new Error(`${ref}: ${failed.get(ref)}`)
    if (!found) throw new Error(`${ref} is not a configured chatgpt-web account (system workers)`)
    return found
  }
  const login = async (ref: string, cookies: string | undefined) => webLogin((await account(ref)).web, { cookies, display: process.env.DISPLAY })
  const loginRemote = async (ref: string): Promise<RemoteView> => {
    const { web } = await account(ref)
    if (remotes.has(ref)) throw new Error(`a remote sign-in of ${ref} is already running: finish it, or cancel it (system workers login ${ref} --remote, then Ctrl-C)`)
    const session = await startRemoteLogin(web)
    remotes.set(ref, session)
    void session.done.then(() => { if (remotes.get(ref) === session) remotes.delete(ref) })
    return { url: session.url, port: session.port, ssh: session.ssh, expiresAt: session.expiresAt }
  }
  const loginWait = async (ref: string, cancel: boolean) => {
    const session = remotes.get(ref)
    if (!session) throw new Error(`no remote sign-in of ${ref} is running`)
    if (cancel) await session.cancel()
    const report = await session.done
    // A successful sign-in does the recheck itself: the Account is ready again only when the checks pass.
    if (!report.signedIn) return report
    const checked = await recheckOf(ref)
    return checked.ready ? report : { ...report, signedIn: false, detail: `signed in, but ${checked.detail}` }
  }
  const recheckOf = async (ref: string): Promise<RecheckReport> => {
    const { web, health } = await account(ref)
    return recheck(web, health)
  }
  ctx.provide('webWorker', { register, expect, login, loginRemote, loginWait, recheck: recheckOf } satisfies WebWorkerService)
}
