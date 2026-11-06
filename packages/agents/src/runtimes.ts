/**
 * How each agent CLI is invoked headless and how its output is read
 * (ADR-0004 decision 6, ADR-0005). Pure functions; spawning is the adapter's.
 */
import type { Workspace } from './workspace.ts'

export type Runtime = 'claude-code' | 'codex'

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
  usage?: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens: number; source: string }
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
      command, '-p', prompt, '--output-format', 'json',
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

export function parseClaude(stdout: string): Parsed {
  let result: { is_error?: boolean; result?: unknown; subtype?: string; usage?: Record<string, number>; modelUsage?: Record<string, unknown> }
  try {
    result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
  } catch {
    return { ok: false, message: `unreadable Claude Code output: ${stdout.slice(0, 200)}` }
  }
  const u = result.usage
  return {
    ok: result.is_error === false,
    message: String(result.result ?? result.subtype ?? ''),
    servedModels: result.modelUsage ? Object.keys(result.modelUsage).sort() : undefined,
    usage: u && Number.isInteger(u.input_tokens) && Number.isInteger(u.output_tokens)
      ? {
          inputTokens: u.input_tokens! + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          // The split is reported whole or not at all, so a half-reported one never reads as zero cache.
          ...(Number.isInteger(u.cache_read_input_tokens) && Number.isInteger(u.cache_creation_input_tokens)
            ? { cacheReadTokens: u.cache_read_input_tokens!, cacheWriteTokens: u.cache_creation_input_tokens! }
            : {}),
          outputTokens: u.output_tokens!,
          source: 'claude-code result.usage (input_tokens is fresh; total adds cache_creation and cache_read)',
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
