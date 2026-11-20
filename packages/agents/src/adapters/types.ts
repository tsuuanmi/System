/** What one CLI Runtime must provide; everything that differs between Runtimes lives behind it. */
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AttemptSummary, Progress, Tier } from '@system/work'
import type { Account } from '../agent.ts'
import type { Observed, QuotaCache, QuotaEvent } from '../quota.ts'
import type { Invocation, Parsed, Runtime } from '../runtimes.ts'
import type { Workspace } from '../workspace.ts'
import type { SandboxHost, SandboxOption } from './sandbox.ts'

export interface InvocationInput {
  command: string
  ws: Workspace
  prompt: string
  model?: string
  /** The attempt changes a repository. */
  codeWrite: boolean
  /** The staged credential's variables. */
  env: Record<string, string>
  /** The Account's `sandbox` option; only an adapter with `sandboxes` takes it. */
  sandbox?: SandboxOption
  /** A test hook: the host's home and git facts for the sandbox settings. */
  host?: SandboxHost
}

/** A credential staged in a directory: its variables, and what to do once the CLI is done (keep a refreshed login). */
export interface Staged {
  env: Record<string, string>
  finish(): void
}

export type Preflight = { failed: string } | { stage(dir: string): Staged }

/** What an adapter reads from an account's profile entry to register it. */
export interface RegisterInput {
  account: { ref: string; tokenRef?: string; claudeHome?: string; codexHome?: string; models?: Partial<Record<Tier, string>> }
  /** The Account being built; the adapter sets its credential fields and hooks. */
  resolved: Account
  command: string
  credentials: CredentialProvider
  /** A path relative to $DSH_HOME/system. */
  home(relative: string): string
  quota: { ttlMs?: number; now?: () => number }
  observations?: { get(ref: string): Observed | undefined; put(ref: string, observed: Observed): Promise<unknown> }
}

export interface CliAdapter {
  readonly runtime: Runtime
  /** The CLI's name, resolved on PATH when the account names none. */
  readonly defaultCommand: string
  /** The account's credential problem, or how to stage it in a directory: checked before anything is prepared. */
  preflight(account: Account): Promise<Preflight>
  invocation(input: InvocationInput): Invocation
  /** Whether the Runtime has the `sandbox` option (a spike: Claude Code only). */
  readonly sandboxes?: boolean
  /** One turn with no tools in an empty directory (cls-1). */
  askArgv(input: { command: string; prompt: string; model: string; work: string }): string[]
  parse(stdout: string): Parsed
  /** A reader of the stdout so far, called as it grows. */
  progress(): (stdout: string) => Progress
  summarize(output: string): AttemptSummary
  /** The quota windows a stream reported, for the Runtimes that report them. */
  rateLimitEvents?(stdout: string): QuotaEvent[]
  /** The provider's account ID from the files in `dir`, or undefined. */
  accountId(dir: string): string | undefined
  /** Check the credential, set the Account's fields and build its quota reader; throws why the account cannot register. */
  register(input: RegisterInput): Promise<{ quota: QuotaCache; providerAccount?: string }>
}
