/**
 * How each agent CLI is invoked headless and how its output is read
 * (ADR-0004 decision 6, ADR-0005). Pure functions; spawning is the adapter's.
 */
import type { Workspace } from './workspace.ts'

export type Runtime = 'claude-code' | 'codex' | 'chatgpt-web'

export interface Invocation {
  argv: string[]
  /** Exactly the variables the agent may see; everything else is removed. */
  env: Record<string, string>
}

export interface Parsed {
  ok: boolean
  message: string
  /** Models the CLI says it used, when it says. */
  servedModels?: string[]
  /** `inputTokens` is the total; fresh input is it minus the cache fields, which are absent when the CLI did not split them. */
  usage?: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens: number; /** API-equivalent cost the CLI estimated client-side, summed over its results; absent when it did not report one. */ costUsd?: number; source: string }
}

/** Variables kept from the host environment; credentials come only from the account. */
const KEEP = ['PATH', 'LANG', 'LC_ALL', 'TZ']

function baseEnv(ws: Workspace): Record<string, string> {
  const env: Record<string, string> = { HOME: ws.home, TMPDIR: ws.home }
  for (const key of KEEP) if (process.env[key]) env[key] = process.env[key]!
  return env
}

export function claudeInvocation(command: string, ws: Workspace, prompt: string, token: string, model?: string): Invocation {
  return {
    argv: [
      command, '-p', prompt, '--output-format', 'stream-json', '--verbose',
      ...(model ? ['--model', model] : []),
      '--permission-mode', 'acceptEdits',
      '--add-dir', ws.inputs, '--add-dir', ws.outputs,
      '--allowedTools', 'Bash', 'WebSearch', 'WebFetch',
      // Deny wins over allow: no Worker pushes or uses the GitHub CLI (ADR-0004 decision 10).
      '--disallowedTools', 'Bash(git push:*)', 'Bash(gh:*)',
    ],
    env: { ...baseEnv(ws), CLAUDE_CODE_OAUTH_TOKEN: token },
  }
}

interface ClaudeResult {
  is_error?: boolean
  result?: unknown
  subtype?: string
  usage?: Record<string, number>
  total_cost_usd?: unknown
  modelUsage?: Record<string, unknown>
}

interface Counts { input?: number; read?: number; write?: number; output?: number; cost?: number }

const count = (n: unknown) => (Number.isInteger(n) ? (n as number) : undefined)
const price = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined)

/** One model's entry of a result's `modelUsage`, which includes the models of subagents. */
function modelCounts(m: unknown): Counts {
  const u = (m ?? {}) as Record<string, unknown>
  return { input: count(u.inputTokens), read: count(u.cacheReadInputTokens), write: count(u.cacheCreationInputTokens), output: count(u.outputTokens), cost: price(u.costUSD) }
}

/** A result's `usage`, which excludes subagents; its cost, `total_cost_usd`, includes them. */
function usageCounts(r: ClaudeResult): Counts {
  const u = r.usage ?? {}
  return { input: count(u.input_tokens), read: count(u.cache_read_input_tokens), write: count(u.cache_creation_input_tokens), output: count(u.output_tokens), cost: price(r.total_cost_usd) }
}

/** `stream-json` prints one `result` per turn, so a follow-up turn (a background command's notification) adds one; usage is summed over all of them, and over every model in each. */
export function parseClaude(stdout: string): Parsed {
  const results: ClaudeResult[] = []
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event?.type === 'result') results.push(event)
    } catch {
      continue
    }
  }
  const last = results.at(-1)
  if (!last) return { ok: false, message: `unreadable Claude Code output: ${stdout.slice(0, 200)}` }
  /** `modelUsage` counts subagents, `usage` does not; use it when every result has it (a result that has none leaves the whole stream on `usage`). */
  const byModel = results.every((r) => r.modelUsage && Object.keys(r.modelUsage).length > 0)
  let input = 0
  let read = 0
  let write = 0
  let output = 0
  let cost = 0
  /** A result without both counts makes the total unknown, never a partial sum; likewise the split and the cost. */
  let counted = true
  let split = true
  let priced = true
  for (const r of results) {
    const parts: Counts[] = byModel ? Object.values(r.modelUsage!).map(modelCounts) : [usageCounts(r)]
    for (const p of parts) {
      if (p.input === undefined || p.output === undefined) {
        counted = false
        continue
      }
      input += p.input
      output += p.output
      // The split is reported whole or not at all, so a half-reported one never reads as zero cache.
      if (p.read !== undefined && p.write !== undefined) {
        read += p.read
        write += p.write
      } else {
        split = false
      }
      input += (p.read ?? 0) + (p.write ?? 0)
      if (p.cost === undefined) priced = false
      else cost += p.cost
    }
  }
  return {
    ok: last.is_error === false,
    message: String(last.result ?? last.subtype ?? ''),
    servedModels: results.some((r) => r.modelUsage) ? [...new Set(results.flatMap((r) => Object.keys(r.modelUsage ?? {})))].sort() : undefined,
    usage: counted
      ? {
          inputTokens: input,
          ...(split ? { cacheReadTokens: read, cacheWriteTokens: write } : {}),
          outputTokens: output,
          ...(priced ? { costUsd: cost } : {}),
          source: byModel
            ? `claude-code modelUsage (includes subagents) over ${results.length} result(s) (inputTokens is fresh; total adds cache_creation and cache_read); cost is a client-side API-equivalent estimate`
            : `claude-code usage (excludes subagents) over ${results.length} result(s) (input_tokens is fresh; total adds cache_creation and cache_read); cost is a client-side API-equivalent estimate`,
        }
      : undefined,
  }
}

export function codexInvocation(command: string, ws: Workspace, prompt: string, codexHome: string, model?: string): Invocation {
  return {
    argv: [
      command, 'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      ...(model ? ['-m', model] : []),
      '-s', 'workspace-write', '-C', ws.work, '--add-dir', ws.outputs, prompt,
    ],
    env: { ...baseEnv(ws), CODEX_HOME: codexHome },
  }
}

export function parseCodex(stdout: string): Parsed {
  let input = 0
  let cached = 0
  let output = 0
  let turns = 0
  /** A turn without both counts makes the total unknown, never a partial sum. */
  let counted = true
  /** Cache reads are known only if every turn reported them. */
  let split = true
  let failure: string | undefined
  let message = ''
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event: { type?: string; usage?: Record<string, number>; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'turn.completed') {
      turns += 1
      const u = event.usage
      if (u && Number.isInteger(u.input_tokens) && Number.isInteger(u.output_tokens)) {
        input += u.input_tokens!
        output += u.output_tokens!
        if (Number.isInteger(u.cached_input_tokens)) cached += u.cached_input_tokens!
        else split = false
      } else {
        counted = false
      }
    }
    if (event.type === 'turn.failed' || event.type === 'error') failure = event.error?.message ?? event.message ?? event.type
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text ?? message
  }
  return {
    ok: turns > 0 && failure === undefined,
    message: failure ?? message,
    usage: turns && counted
      ? {
          inputTokens: input,
          ...(split ? { cacheReadTokens: cached } : {}),
          outputTokens: output,
          source: `codex turn.completed usage over ${turns} turn(s) (input_tokens includes cached_input_tokens)`,
        }
      : undefined,
  }
}
