/**
 * The `web-worker` row: the `chatgpt-web` Runtime as its own, optional row (WW2a). It registers the `chatgpt-web`
 * accounts the `agents` row hands it as Workers and owns their sign-in (`ctx.webWorker`: cookie import, a window,
 * the remote viewer). With the row off nothing of this package is loaded and those accounts are unavailable.
 */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { lazyVersion, type RemoteView, type WebRegistration, type WebWorkerService } from '@system/agents'
import type { Artifacts } from '@system/artifacts'
import { systemPath, type Capabilities } from '@system/work'
import { checkProcedures, webDefaults, webWorker, type WebConfig } from './chatgpt.ts'
import { webLogin } from './chatgpt-login.ts'
import { discoverChrome } from './chrome.ts'
import { XVFB_MISSING, findXvfb } from './display.ts'
import { startRemoteLogin, type RemoteSession } from './remote-login.ts'

export * from './chatgpt.ts'
export * from './chatgpt-login.ts'
export * from './remote-login.ts'
export * from './display.ts'

export const name = 'system-web-worker'
export const inject = ['capabilities', 'artifacts', 'subprocess']

export function apply(ctx: Context): void {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const attempts = systemPath(ctx, 'attempts')
  const webs = new Map<string, WebConfig>()
  const disposers = new Set<() => void>()
  const register = async (account: WebRegistration) => {
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
    const version = lazyVersion(subprocess, command)
    const off = capabilities.registerWorker(webWorker({ ref: account.ref, capabilities: account.capabilities, command, version, attemptTimeoutMinutes: account.attemptTimeoutMinutes, maxConcurrentAttempts: account.maxConcurrentAttempts, web }, artifacts, attempts))
    webs.set(account.ref, web)
    const dispose = () => {
      if (!disposers.delete(dispose)) return
      if (webs.get(account.ref) === web) webs.delete(account.ref)
      off()
    }
    disposers.add(dispose)
    return { command, version, dispose }
  }
  ctx.effect(() => () => { for (const dispose of [...disposers]) dispose() }, 'web worker registrations')
  const remotes = new Map<string, RemoteSession>()
  ctx.effect(() => () => { for (const remote of remotes.values()) void remote.cancel() }, 'remote sign-ins')
  const account = (ref: string) => {
    const web = webs.get(ref)
    if (!web) throw new Error(`${ref} is not an available chatgpt-web account (system workers)`)
    return web
  }
  const login = async (ref: string, cookies: string | undefined) => webLogin(account(ref), { cookies, display: process.env.DISPLAY })
  const loginRemote = async (ref: string): Promise<RemoteView> => {
    const web = account(ref)
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
    return session.done
  }
  ctx.provide('webWorker', { register, login, loginRemote, loginWait } satisfies WebWorkerService)
}
