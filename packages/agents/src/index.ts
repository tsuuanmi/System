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
import { agentWorker, recordingPid, type Account, type Spawner } from './agent.ts'
import { webDefaults, type WebConfig } from './chatgpt.ts'
import { discoverChrome } from './chrome.ts'
import { webLogin, type LoginReport } from './chatgpt-login.ts'
import { XVFB_MISSING, findXvfb } from './display.ts'
import { startRemoteLogin, type RemoteSession } from './remote-login.ts'
import type { Runtime } from './runtimes.ts'

export * from './agent.ts'
export * from './chatgpt.ts'
export * from './chatgpt-login.ts'
export * from './remote-login.ts'
export * from './display.ts'
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
  /** chatgpt-web: the Chrome profile (the signed-in session), relative to $DSH_HOME/system unless absolute; default `chatgpt-web/<name>`. */
  profileDir?: string
  /** chatgpt-web: open each attempt in a temporary chat (default true). */
  temporaryChat?: boolean
  /** chatgpt-web: the page to open (default https://chatgpt.com/). */
  url?: string
  /** chatgpt-web: the Chrome to drive; default `CHROME_PATH`, a system Chrome as new as the engine's Chromium, else the pinned Chrome for Testing, installed under $DSH_HOME/system/browsers on first use. */
  executablePath?: string
  /** chatgpt-web: seconds per stage (`load`, `send`, `answer`) and how long the answer's text must stay unchanged (`stable`). */
  timeouts?: Partial<WebConfig['timeouts']>
  /** The model per tier; each listed tier adds the capability `tier.<name>`. */
  models?: Partial<Record<Tier, string>>
  /** Wall-clock limit of one attempt, in minutes; overrides the row's. */
  attemptTimeoutMinutes?: number
  /** How many attempts of this account run at once; overrides the row's. */
  maxConcurrentAttempts?: number
}

export interface Config {
  /** Wall-clock limit of one attempt, in minutes (fractions allowed); default 60. */
  attemptTimeoutMinutes?: number
  /** How many attempts of one account run at once (the Host's slots); default 1. */
  maxConcurrentAttempts?: number
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

export type RemoteView = Pick<RemoteSession, 'url' | 'port' | 'ssh' | 'expiresAt'>

export interface AgentsService {
  /** Every configured account; the CLI version of each available one is asked here, once. */
  accounts(): Promise<AccountStatus[]>
  /** Sign a chatgpt-web account in, by the contents of a cookie file or by hand in a window (needs a display). */
  login(ref: string, cookies: string | undefined): Promise<LoginReport>
  /** Start a remote sign-in (the viewer on 127.0.0.1, behind a token); one per account at a time. */
  loginRemote(ref: string): Promise<RemoteView>
  /** Wait for the account's remote sign-in to end (Save, Cancel or expiry), or with `cancel` end it now, and report. */
  loginWait(ref: string, cancel: boolean): Promise<LoginReport>
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
  const attempts = systemPath(ctx, 'attempts')
  const statuses: AccountStatus[] = []
  const versions = new Map<string, () => Promise<string>>()
  const webs = new Map<string, WebConfig>()
  const dispose: (() => void)[] = []
  for (const account of config.accounts ?? []) {
    const status: AccountStatus = { ref: account.ref, runtime: account.runtime, capabilities: account.capabilities, available: false, reason: '' }
    statuses.push(status)
    try {
      const web = account.runtime === 'chatgpt-web'
      if (web && 'headless' in account) throw new Error('headless is not an option: System always runs the browser headed, on a private display')
      if (web && !findXvfb()) throw new Error(XVFB_MISSING)
      const browsers = systemPath(ctx, 'browsers')
      const command = web ? discoverChrome(account.executablePath, { managedDir: browsers }).path : await subprocess.resolveExecutable(account.command ?? (account.runtime === 'claude-code' ? 'claude' : 'codex'))
      status.command = command
      const askVersion = lazyVersion(subprocess, command)
      const unknown = Object.keys(account.models ?? {}).filter((tier) => !(TIERS as readonly string[]).includes(tier))
      if (unknown.length) throw new Error(`unknown tier ${unknown.join(', ')}; tiers are ${TIERS.join(', ')}`)
      const tiers = TIERS.filter((tier) => account.models?.[tier])
      const slots = account.maxConcurrentAttempts ?? config.maxConcurrentAttempts
      if (slots !== undefined && !(Number.isInteger(slots) && slots >= 1)) throw new Error(`maxConcurrentAttempts is ${slots}; it must be a whole number of at least 1`)
      const offered = [...account.capabilities, ...tiers.map(tierCapability)]
      status.capabilities = offered
      const resolved: Account = { ref: account.ref, runtime: account.runtime, capabilities: offered, command, version: askVersion, models: account.models, attemptTimeoutMinutes: account.attemptTimeoutMinutes ?? config.attemptTimeoutMinutes, maxConcurrentAttempts: slots }
      if (web) {
        const profile = account.profileDir ?? `chatgpt-web/${account.ref.split('/')[1] ?? 'default'}`
        const defaults = webDefaults(isAbsolute(profile) ? profile : systemPath(ctx, profile))
        const config: WebConfig = {
          ...defaults, ...(account.executablePath ? { executablePath: account.executablePath } : {}), managedDir: browsers, temporaryChat: account.temporaryChat ?? defaults.temporaryChat,
          url: account.url ?? defaults.url, timeouts: { ...defaults.timeouts, ...account.timeouts },
        }
        new URL(config.url)
        for (const [stage, seconds] of Object.entries(config.timeouts)) {
          if (!(typeof seconds === 'number' && seconds > 0)) throw new Error(`timeouts.${stage} is ${seconds}; it must be a number of seconds above 0`)
        }
        resolved.web = config
        webs.set(account.ref, config)
      } else if (account.runtime === 'claude-code') {
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
  const remotes = new Map<string, RemoteSession>()
  ctx.effect(() => () => { for (const remote of remotes.values()) void remote.cancel() }, 'remote sign-ins')
  const login = async (ref: string, cookies: string | undefined) => {
    const config = webs.get(ref)
    if (!config) throw new Error(`${ref} is not an available chatgpt-web account (system workers)`)
    return webLogin(config, { cookies, display: process.env.DISPLAY })
  }
  const loginRemote = async (ref: string): Promise<RemoteView> => {
    const config = webs.get(ref)
    if (!config) throw new Error(`${ref} is not an available chatgpt-web account (system workers)`)
    if (remotes.has(ref)) throw new Error(`a remote sign-in of ${ref} is already running: finish it, or cancel it (system workers login ${ref} --remote, then Ctrl-C)`)
    const session = await startRemoteLogin(config)
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
  ctx.provide('agents', { accounts, login, loginRemote, loginWait } satisfies AgentsService)
}
