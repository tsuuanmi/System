/**
 * How each agent CLI is invoked headless and how its output is read
 * (ADR-0004 decision 6, ADR-0005). Pure functions; spawning is the adapter's.
 */
import type { Progress } from '@system/work'
import type { Workspace } from './workspace.ts'

export type Runtime = 'claude-code' | 'codex' | 'chatgpt-web' | 'acp'

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

/**
 * `codeWrite`: the attempt changes a repository (PROP-0007 decision 1), so it
 * may not start background tasks or monitors: a wait on one re-reads the whole
 * context at every wake.
 */
export function claudeInvocation(command: string, ws: Workspace, prompt: string, token: string, model?: string, codeWrite = false): Invocation {
  return {
    argv: [
      command, '-p', prompt, '--output-format', 'stream-json', '--verbose',
      ...(model ? ['--model', model] : []),
      '--permission-mode', 'acceptEdits',
      '--add-dir', ws.inputs, '--add-dir', ws.outputs,
      '--allowedTools', 'Bash', 'WebSearch', 'WebFetch',
      // Deny wins over allow: no Worker pushes or uses the GitHub CLI (ADR-0004 decision 10).
      '--disallowedTools', 'Bash(git push:*)', 'Bash(gh:*)', ...(codeWrite ? ['Monitor'] : []),
    ],
    env: { ...baseEnv(ws), CLAUDE_CODE_OAUTH_TOKEN: token, ...(codeWrite ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } : {}) },
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

/**
 * What the results add up to, over every model of each when `byModel`. A part
 * without both input and output makes the total unknown, never a partial sum;
 * the cache split and the cost are reported whole or not at all, so a
 * half-reported one never reads as zero cache or a cheaper run.
 */
function totalUsage(results: ClaudeResult[], byModel: boolean): Omit<NonNullable<Parsed['usage']>, 'source'> | undefined {
  const parts = results.flatMap((r) => (byModel ? Object.values(r.modelUsage!).map(modelCounts) : [usageCounts(r)]))
  if (parts.some((p) => p.input === undefined || p.output === undefined)) return undefined
  const sum = (of: (p: Counts) => number) => parts.reduce((total, p) => total + of(p), 0)
  return {
    inputTokens: sum((p) => p.input! + (p.read ?? 0) + (p.write ?? 0)),
    ...(parts.every((p) => p.read !== undefined && p.write !== undefined) ? { cacheReadTokens: sum((p) => p.read!), cacheWriteTokens: sum((p) => p.write!) } : {}),
    outputTokens: sum((p) => p.output!),
    ...(parts.every((p) => p.cost !== undefined) ? { costUsd: sum((p) => p.cost!) } : {}),
  }
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
  const usage = totalUsage(results, byModel)
  return {
    ok: last.is_error === false,
    message: String(last.result ?? last.subtype ?? ''),
    servedModels: results.some((r) => r.modelUsage) ? [...new Set(results.flatMap((r) => Object.keys(r.modelUsage ?? {})))].sort() : undefined,
    usage: usage && {
      ...usage,
      source: byModel
        ? `claude-code modelUsage (includes subagents) over ${results.length} result(s) (inputTokens is fresh; total adds cache_creation and cache_read); cost is a client-side API-equivalent estimate`
        : `claude-code usage (excludes subagents) over ${results.length} result(s) (input_tokens is fresh; total adds cache_creation and cache_read); cost is a client-side API-equivalent estimate`,
    },
  }
}


/** ACP v1 bridge invocation: prompt lives in a private file, never argv. */
export function acpInvocation(
  bridge: string, ws: Workspace, promptFile: string,
  agentCommand: string, agentArgs: string[],
  token?: string, codexHome?: string,
): Invocation {
  return {
    argv: [bridge, '--agent', agentCommand, '--args-json', JSON.stringify(agentArgs), '--prompt-file', promptFile],
    env: {
      ...baseEnv(ws), NO_BROWSER: '1',
      ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    },
  }
}

/** Only an SDK-reported EndTurn with no denied permission is a successful ACP attempt.
 * ACP has no stable per-turn usage in this initial bridge; do not invent token totals. */
export function parseAcp(stdout: string): Parsed {
  let denied = false
  let completion: { ok?: unknown; stopReason?: unknown } | undefined
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event?.type === 'acp.permission_denied') denied = true
      if (event?.type === 'acp.result') completion = event
    } catch { /* invalid lines are not ACP evidence */ }
  }
  if (denied) return { ok: false, message: 'ACP agent requested permissions denied by System; no automatic approval' }
  if (!completion) return { ok: false, message: 'ACP bridge did not report a completed turn' }
  const ok = completion.ok === true && completion.stopReason === 'EndTurn'
  return { ok, message: ok ? 'ACP v1 EndTurn' : `ACP did not end normally: ${String(completion.stopReason ?? 'unknown')}` }
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

/**
 * Read an agent's progress from its stdout as it grows: call the reader with
 * the whole stdout so far; it parses only the complete lines it has not seen.
 * Claude Code: a turn is an assistant message (one message may stream as
 * several events), the last tool is the last `tool_use`, tokens are fresh
 * input, cache writes and output per message. Codex: a turn is a
 * `turn.completed`, the last tool the type of the last item completed.
 */
export function progressReader(runtime: Exclude<Runtime, 'chatgpt-web'>): (stdout: string) => Progress {
  let consumed = 0
  const messages = new Map<string, { tokens: number; input: number }>()
  let turns = 0
  let tokens = 0
  let input = 0
  let lastTool: string | undefined
  let stage: string | undefined
  const n = (value: unknown) => (Number.isInteger(value) ? (value as number) : 0)
  return (stdout) => {
    const end = stdout.lastIndexOf('\n') + 1
    for (const line of stdout.slice(consumed, Math.max(consumed, end)).split('\n')) {
      let event: any
      try { event = JSON.parse(line) } catch { continue }
      if (runtime === 'acp' && typeof event?.type === 'string' && event.type.startsWith('acp.')) stage = event.type.slice(4)
      if (runtime === 'claude-code' && event?.type === 'assistant' && event.message) {
        const u = event.message.usage ?? {}
        messages.set(String(event.message.id ?? messages.size), {
          tokens: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens),
          input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
        })
        for (const part of event.message.content ?? []) if (part?.type === 'tool_use' && typeof part.name === 'string') lastTool = part.name
      }
      if (runtime === 'codex' && event?.type === 'turn.completed') {
        turns += 1
        tokens += n(event.usage?.input_tokens) - n(event.usage?.cached_input_tokens) + n(event.usage?.output_tokens)
        input += n(event.usage?.input_tokens)
      }
      if (runtime === 'codex' && event?.type === 'item.completed' && typeof event.item?.type === 'string' && event.item.type !== 'agent_message') lastTool = event.item.type
    }
    consumed = Math.max(consumed, end)
    const all = [...messages.values()]
    const counted = runtime === 'claude-code'
      ? { turns: messages.size, tokens: all.reduce((a, m) => a + m.tokens, 0), inputTokens: all.reduce((a, m) => a + m.input, 0) }
      : { turns, tokens, inputTokens: input }
    if (runtime === 'acp') return stage ? { stage: `acp.${stage}` } : {}
    return { turns: counted.turns, ...(lastTool ? { lastTool } : {}), tokens: counted.tokens, inputTokens: counted.inputTokens }
  }
}
