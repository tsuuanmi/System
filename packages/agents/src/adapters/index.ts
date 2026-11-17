/**
 * The registry of CLI Runtimes, keyed by Runtime name: the one place that knows which Runtime does what. Callers ask it; none branches on a
 * Runtime's name (a test fails if one does). `web` has no adapter here: the web-worker row serves it (web.ts).
 */
import type { AttemptSummary } from '@system/work'
import { unknownSummary } from '../attempt-summary.ts'
import type { Runtime } from '../runtimes.ts'
import { claudeCode } from './claude-code.ts'
import { codex, keepRefreshedAuth } from './codex.ts'
import type { CliAdapter } from './types.ts'

export type { CliAdapter, InvocationInput, Preflight, RegisterInput, Staged } from './types.ts'
export { keepRefreshedAuth }

const ADAPTERS: Record<Runtime, CliAdapter> = { 'claude-code': claudeCode, codex }

/** The adapter of a Runtime; undefined for one that is not a CLI (`web`). */
export function adapterFor(runtime: string): CliAdapter | undefined {
  return (ADAPTERS as Record<string, CliAdapter | undefined>)[runtime]
}

/** What an attempt did, from its output; a Runtime with no adapter reports every part unknown. */
export function summarizeAttempt(runtime: Runtime | 'web', output: string): AttemptSummary {
  return adapterFor(runtime)?.summarize(output) ?? unknownSummary(runtime)
}
