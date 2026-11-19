/**
 * The spike of an Account's `sandbox` option: Claude Code's own sandbox (bubblewrap on Linux) for what Bash starts, passed with `--settings`.
 * Pure: the host's facts (the passwd home, the repository's git directory) are arguments.
 */
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, relative } from 'node:path'
import { baseEnv } from '../runtimes.ts'
import type { Workspace } from '../workspace.ts'

/** The Account's option: `true`, or extra readable paths and, since Claude Code documents no way to leave the network open, the hosts Bash may reach. */
export type SandboxOption = true | { allowRead?: string[]; allowedDomains?: string[] }

/** What the host says; a test injects it. */
export interface SandboxHost {
  /** The operator's real home: the passwd entry, never $HOME (the attempt's HOME is a throwaway directory). */
  home(): string
  /** The common git directory of the worktree at `work`, absolute, or undefined when it is not one. */
  gitCommonDir(work: string): string | undefined
}

export const realHost: SandboxHost = {
  home: () => userInfo().homedir,
  gitCommonDir(work) {
    try {
      return execFileSync('git', ['-C', work, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
    } catch {
      return undefined
    }
  },
}

export const SANDBOX_RUNTIME_ONLY = 'the sandbox option is a spike that covers the Claude Code Runtime only'

const KEYS = ['allowRead', 'allowedDomains']

/** The option as the profile gave it, or why it is refused; the Runtime check is the caller's (the adapter registry). */
export function parseSandbox(value: unknown): SandboxOption | undefined {
  if (value === undefined) return undefined
  if (value === true) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('sandbox must be true or an object with allowRead and allowedDomains')
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) throw new Error(`sandbox: unknown key ${key}; the keys are ${KEYS.join(', ')}`)
  const { allowRead, allowedDomains } = value as Record<string, unknown>
  const list = (name: string, v: unknown) => {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) throw new Error(`sandbox.${name} must be a list of strings`)
    return v as string[]
  }
  const read = list('allowRead', allowRead)
  if (read?.some((p) => !isAbsolute(p))) throw new Error('sandbox.allowRead paths must be absolute')
  const domains = list('allowedDomains', allowedDomains)
  return { ...(read ? { allowRead: read } : {}), ...(domains ? { allowedDomains: domains } : {}) }
}

const under = (home: string, path: string) => { const r = relative(home, path); return r !== '' && !r.startsWith('..') && !isAbsolute(r) }

/** The settings JSON of one attempt. */
export function sandboxSettings(ws: Workspace, option: SandboxOption, host: SandboxHost = realHost): object {
  const home = host.home()
  const extra = option === true ? {} : option
  const path = (baseEnv(ws).PATH ?? '').split(':').filter(Boolean)
  // The Node toolchain: a PATH entry under the real home, and its parent when that is still under it (corepack lives beside `bin`).
  const toolchain = path.filter((d) => isAbsolute(d) && under(home, d)).flatMap((d) => (under(home, dirname(d)) ? [d, dirname(d)] : [d]))
  const common = host.gitCommonDir(ws.work)
  const allowRead = [...new Set([ws.work, ws.inputs, ws.outputs, ws.home, ...(common && under(home, common) ? [common] : []), ...toolchain, ...(extra.allowRead ?? [])])]
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [home], allowRead, allowWrite: [ws.home, ws.inputs, ws.outputs] },
      network: { allowedDomains: extra.allowedDomains ?? [] },
    },
  }
}
