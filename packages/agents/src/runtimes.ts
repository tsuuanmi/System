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
  usage?: { inputTokens: number; outputTokens: number; source: string }
}

/** Variables kept from the host environment; credentials come only from the account. */
const KEEP = ['PATH', 'LANG', 'LC_ALL', 'TZ']

export function baseEnv(ws: Workspace): Record<string, string> {
  const env: Record<string, string> = { HOME: ws.home, TMPDIR: ws.home }
  for (const key of KEEP) if (process.env[key]) env[key] = process.env[key]!
  return env
}

export function claudeInvocation(command: string, ws: Workspace, prompt: string, token: string): Invocation {
  return {
    argv: [
      command, '-p', prompt, '--output-format', 'json',
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
  let result: { is_error?: boolean; result?: unknown; subtype?: string; usage?: Record<string, number> }
  try {
    result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
  } catch {
    return { ok: false, message: `unreadable Claude Code output: ${stdout.slice(0, 200)}` }
  }
  const u = result.usage
  return {
    ok: result.is_error === false,
    message: String(result.result ?? result.subtype ?? ''),
    usage: u && Number.isInteger(u.input_tokens) && Number.isInteger(u.output_tokens)
      ? {
          inputTokens: u.input_tokens! + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens!,
          source: 'claude-code result.usage (input includes cache reads and writes)',
        }
      : undefined,
  }
}

export function codexInvocation(command: string, ws: Workspace, prompt: string, codexHome: string): Invocation {
  return {
    argv: [
      command, 'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '-s', 'workspace-write', '-C', ws.work, '--add-dir', ws.outputs, prompt,
    ],
    env: { ...baseEnv(ws), CODEX_HOME: codexHome },
  }
}

export function parseCodex(stdout: string): Parsed {
  let input = 0
  let output = 0
  let turns = 0
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
    if (event.type === 'turn.completed' && event.usage) {
      turns += 1
      input += event.usage.input_tokens ?? 0
      output += event.usage.output_tokens ?? 0
    }
    if (event.type === 'turn.failed' || event.type === 'error') failure = event.error?.message ?? event.message ?? event.type
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text ?? message
  }
  return {
    ok: turns > 0 && failure === undefined,
    message: failure ?? message,
    usage: turns ? { inputTokens: input, outputTokens: output, source: `codex turn.completed usage over ${turns} turn(s) (input includes cached)` } : undefined,
  }
}
