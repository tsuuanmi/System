/**
 * The registry of CLI Runtimes, keyed by Runtime name: the one place that knows which Runtime does what. Callers ask it; none branches on a
 * Runtime's name (a test fails if one does). `web` has no adapter here: the runtime-web row serves it.
 */
import type { AttemptSummary } from '@system/work'
import { unknownSummary } from '../attempt-summary.ts'
import type { Runtime } from '../runtimes.ts'
import { antigravity } from './antigravity.ts'
import { claudeCode } from './claude-code.ts'
import { codex, keepRefreshedAuth } from './codex.ts'
import { parseSandbox, type SandboxOption } from './sandbox.ts'
import type { CliAdapter } from './types.ts'

export type { CliAdapter, InvocationInput, Preflight, RegisterInput, Staged } from './types.ts'
export { keepRefreshedAuth }

export const ADAPTERS: Record<Runtime, CliAdapter> = { 'claude-code': claudeCode, codex, antigravity }

/** The adapter of a Runtime; undefined for one that is not a CLI (`web`). */
export function adapterFor(runtime: string): CliAdapter | undefined {
  return (ADAPTERS as Record<string, CliAdapter | undefined>)[runtime]
}

/** What an attempt did, from its output; a Runtime with no adapter reports every part unknown. */
export function summarizeAttempt(runtime: Runtime | 'web', output: string): AttemptSummary {
  return adapterFor(runtime)?.summarize(output) ?? unknownSummary(runtime)
}

/** The Account's `sandbox` option, checked: refused on a Runtime with no process of its own (web), or when it is not `true`. */
export function checkSandbox(runtime: string, value: unknown): SandboxOption | undefined {
  if (value === undefined) return undefined
  if (!adapterFor(runtime)) throw new Error(SANDBOX_WEB)
  return parseSandbox(value)
}

const SANDBOX_WEB = 'the sandbox option wraps a CLI Runtime\'s process; a web account has none'
