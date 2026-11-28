/**
 * The `agents` service's types and its place in Cordis's `Context` (ADR-0017 decision 1): what `ctx.agents` offers other plugins.
 */
import type { Tier } from '@system/work'
import type { Ask } from './ask.ts'
import type { QuotaReport } from './quota.ts'
import type { Runtime } from './runtimes.ts'

/** `web` is the web Runtime, served by the `web-worker` row; its Site is the account's `site`. */
export type AccountRuntime = Runtime | 'web'

/** The reason of an account whose registration is not done yet. */
export const REGISTERING = 'registering'

/** Why an Account whose quota read failed with an authentication error is unavailable. */
export const SIGNED_OUT_REASON = 'signed out'

export interface AccountStatus {
  ref: string
  runtime: AccountRuntime
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

export interface AgentsService {
  /** One model turn with no tools on an economy-tier Account that is not in `exclude` (the Classifier's, cls-1); a refusal says why none could answer. Never throws. */
  ask: Ask
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentsService
  }
}
