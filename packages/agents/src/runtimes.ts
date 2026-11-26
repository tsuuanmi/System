/**
 * How each agent CLI is invoked headless and how its output is read
 * (ADR-0004 decision 6, ADR-0005). Pure functions; spawning is the adapter's.
 */
import type { ExecutorRecord, FinalResult } from '@system/work'
import { nodeBin } from './node.ts'
import type { Workspace } from './workspace.ts'

export type Runtime = 'claude-code' | 'codex' | 'antigravity'

/**
 * What each Runtime can do, declared here and not granted in the profile (nm-1): a Worker's capabilities are its Runtime's abilities plus the Roles and
 * Tiers its profile entry grants. The `web` Runtime is the Website Worker's.
 */
export const RUNTIME_ABILITIES = {
  'claude-code': ['repo.read', 'repo.write', 'web.search'],
  codex: ['repo.read', 'repo.write'],
  antigravity: ['repo.read', 'repo.write'],
  web: ['web.search', 'web.browse'],
} as const satisfies Record<Runtime | 'web', readonly string[]>

/** What an Invocation bounds the Worker to, recorded on the attempt. */
export type Scope = NonNullable<ExecutorRecord['scope']>

export interface Invocation {
  argv: string[]
  /** Exactly the variables the agent may see; everything else is removed. */
  env: Record<string, string>
  /** The tool scope the argv and staged settings give, computed from the same values. */
  scope: Scope
}

export interface Parsed {
  ok: boolean
  message: string
  /** finish-1: structured final result when the Runtime reports one. */
  finalResult?: FinalResult
  /** Models the CLI says it used, when it says. */
  servedModels?: string[]
  /** `inputTokens` is the total; fresh input is it minus the cache fields, which are absent when the CLI did not split them. */
  usage?: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens: number; /** API-equivalent cost the CLI estimated client-side, summed over its results; absent when it did not report one. */ costUsd?: number; source: string }
}

/** Variables kept from the host environment; credentials come only from the account. */
const KEEP = ['PATH', 'LANG', 'LC_ALL', 'TZ']

/**
 * A Guardrail against accident, not a sandbox: git inside an attempt (`git -C <dir> push`, `git fetch`) over ssh runs this and
 * is refused, because OpenSSH finds ~/.ssh from the passwd entry, not from $HOME. An agent that unsets the variable gets past it.
 * Needs no file outside the attempt.
 */
export const GIT_SSH_REFUSAL = `sh -c 'echo "System gives a Worker no push access." >&2; exit 1' --`

export function baseEnv(ws: Workspace): Record<string, string> {
  const env: Record<string, string> = { HOME: ws.home, TMPDIR: ws.home, GIT_SSH_COMMAND: GIT_SSH_REFUSAL }
  for (const key of KEEP) if (process.env[key]) env[key] = process.env[key]!
  // The repository's Node first on PATH, as a check gets it (fl-3): under the throwaway HOME `bin/system` cannot find a newer one itself.
  let bin: string | undefined
  try {
    bin = nodeBin(ws.work)
  } catch {
    // None installed satisfies it: the host's PATH as it is, and the tests say why.
  }
  const path = [bin, process.env.PATH].filter(Boolean).join(':')
  if (path) env.PATH = path
  return env
}
