/** The Claude Code Runtime: how its CLI is invoked, staged, read and measured (ADR-0004 decision 6, ADR-0005). */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AttemptSummary, Progress } from '@system/work'
import { jsonEvents, unknownSummary } from '../attempt-summary.ts'
import { createQuotaCache, probeClaudeQuota, quotaFromRateLimitEvent, readClaudeQuota, type QuotaEvent } from '../quota.ts'
import { baseEnv, type Invocation, type Parsed } from '../runtimes.ts'
import { readClaudeAccountId } from '../identity.ts'
import { sandboxSettings, realHost } from './sandbox.ts'
import type { CliAdapter, InvocationInput } from './types.ts'

/**
 * `codeWrite`: the attempt changes a repository (PROP-0007 decision 1), so it
 * may not start background tasks or monitors: a wait on one re-reads the whole
 * context at every wake.
 */
function invocation({ command, ws, prompt, model, codeWrite, env, sandbox, host }: InvocationInput): Invocation {
  const allowed = ['Bash', 'WebSearch', 'WebFetch']
  // Deny wins over allow: no Worker pushes or uses the GitHub CLI (ADR-0004 decision 10).
  const denied = ['Bash(git push:*)', 'Bash(gh:*)', ...(codeWrite ? ['Monitor'] : [])]
  const settings = sandbox ? JSON.stringify(sandboxSettings(ws, sandbox, host ?? realHost)) : undefined
  return {
    argv: [
      command, '-p', prompt, '--output-format', 'stream-json', '--verbose',
      ...(model ? ['--model', model] : []),
      '--permission-mode', 'acceptEdits',
      '--add-dir', ws.inputs, '--add-dir', ws.outputs,
      '--allowedTools', ...allowed,
      '--disallowedTools', ...denied,
      ...(settings ? ['--settings', settings] : []),
    ],
    scope: { permissionMode: 'acceptEdits', allowedTools: allowed, disallowedTools: denied, sandbox: Boolean(sandbox), ...(settings ? { settingsSha256: createHash('sha256').update(settings).digest('hex') } : {}) },
    env: { ...baseEnv(ws), ...env, ...(codeWrite ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } : {}) },
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
function parse(stdout: string): Parsed {
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
  if (!last) return { ok: false, message: `unreadable Claude Code output: ${stdout.slice(0, 200)}`, usageGap: 'claude-code printed no result event' }
  /** `modelUsage` counts subagents, `usage` does not; use it when every result has it (a result that has none leaves the whole stream on `usage`). */
  const byModel = results.every((r) => r.modelUsage && Object.keys(r.modelUsage).length > 0)
  const usage = totalUsage(results, byModel)
  return {
    ...(usage ? {} : { usageGap: 'claude-code result events carried no input and output token counts' }),
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

/** The last quota event of each window in a Claude Code stream. */
function rateLimitEvents(stdout: string): QuotaEvent[] {
  const last = new Map<string, QuotaEvent>()
  const observedAt = Date.now()
  for (const line of stdout.split('\n')) {
    if (!line.includes('rate_limit_event')) continue
    try {
      for (const event of quotaFromRateLimitEvent(JSON.parse(line) as unknown, observedAt)) last.set(event.window, event)
    } catch { /* not JSON: not an event */ }
  }
  return [...last.values()]
}

/**
 * Progress read from stdout as it grows: the reader is called with the whole stdout so far and parses only the complete lines it has not
 * seen. A turn is an assistant message (one message may stream as several events), the last tool is the last `tool_use`, tokens are fresh
 * input, cache writes and output per message.
 */
function progress(): (stdout: string) => Progress {
  let consumed = 0
  const messages = new Map<string, { tokens: number; input: number }>()
  let lastTool: string | undefined
  const n = (value: unknown) => (Number.isInteger(value) ? (value as number) : 0)
  return (stdout) => {
    const end = stdout.lastIndexOf('\n') + 1
    for (const line of stdout.slice(consumed, Math.max(consumed, end)).split('\n')) {
      let event: any
      try { event = JSON.parse(line) } catch { continue }
      if (event?.type === 'assistant' && event.message) {
        const u = event.message.usage ?? {}
        messages.set(String(event.message.id ?? messages.size), {
          tokens: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens),
          input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
        })
        for (const part of event.message.content ?? []) if (part?.type === 'tool_use' && typeof part.name === 'string') lastTool = part.name
      }
    }
    consumed = Math.max(consumed, end)
    const all = [...messages.values()]
    return { turns: messages.size, ...(lastTool ? { lastTool } : {}), tokens: all.reduce((a, m) => a + m.tokens, 0), inputTokens: all.reduce((a, m) => a + m.input, 0) }
  }
}

/** What an attempt did, from its stream: tool calls by name, files read and edited, the longest tool calls and the tool-seconds per second of the attempt. */
function summarize(output: string): AttemptSummary {
  const MAX_FILES = 200
  const MAX_LONGEST = 5
  const COMMAND_CHARS = 120
  const toolCalls: Record<string, number> = {}
  const read = new Set<string>()
  const edited = new Set<string>()
  const calls = new Map<string, { tool: string; command?: string }>()
  const elapsed = new Map<string, { tool: string; seconds: number }>()
  let durationMs: number | undefined
  let numTurns: number | undefined
  for (const event of jsonEvents(output)) {
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
        toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1
        const path = block.input?.file_path
        if (typeof path === 'string') {
          if (block.name === 'Read') read.add(path)
          if (block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit') edited.add(path)
        }
        const command = block.name === 'Bash' && typeof block.input?.command === 'string' ? block.input.command.slice(0, COMMAND_CHARS) : undefined
        if (typeof block.id === 'string') calls.set(block.id, { tool: block.name, ...(command === undefined ? {} : { command }) })
      }
    } else if (event.type === 'tool_progress' && typeof event.elapsed_time_seconds === 'number') {
      // The heartbeats of one tool call carry its ID; the longest one is how long the call took.
      const key = String(event.tool_use_id ?? event.parent_tool_use_id)
      const before = elapsed.get(key)
      if (!before || event.elapsed_time_seconds > before.seconds) elapsed.set(key, { tool: String(event.tool_name ?? before?.tool ?? 'unknown'), seconds: event.elapsed_time_seconds })
    } else if (event.type === 'result') {
      if (typeof event.duration_ms === 'number') durationMs = (durationMs ?? 0) + event.duration_ms
      if (typeof event.num_turns === 'number') numTurns = event.num_turns
    }
  }
  const longest = [...elapsed.entries()]
    .map(([key, { tool, seconds }]) => { const call = calls.get(key); return { tool: call?.tool ?? tool, seconds, ...(call?.command === undefined ? {} : { command: call.command }) } })
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, MAX_LONGEST)
  const toolSeconds = [...elapsed.values()].reduce((sum, { seconds }) => sum + seconds, 0)
  const unknown = unknownSummary('claude-code')
  return {
    runtime: 'claude-code', toolCalls, filesRead: [...read].slice(0, MAX_FILES), filesEdited: [...edited].slice(0, MAX_FILES), longest,
    toolSeconds: Object.keys(toolCalls).length || elapsed.size ? toolSeconds : unknown.toolSeconds,
    toolShare: durationMs ? Math.round((toolSeconds / (durationMs / 1000)) * 100) / 100 : unknown.toolShare,
    durationMs: durationMs ?? unknown.durationMs, numTurns: numTurns ?? unknown.numTurns,
  }
}

export const claudeCode: CliAdapter = {
  runtime: 'claude-code',
  defaultCommand: 'claude',
  async preflight(account) {
    // The credential is checked before anything is prepared: without it there is nothing to run.
    const token = await account.token?.()
    if (!token) return { failed: `${account.ref}: its token is not configured (system credentials set)` }
    return { stage: () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: token }, finish() {} }) }
  },
  invocation,
  sandboxes: true,
  askArgv: ({ command, prompt, model }) => [command, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--no-session-persistence', '--strict-mcp-config', '--tools', ''],
  parse,
  progress,
  summarize,
  rateLimitEvents,
  accountId: readClaudeAccountId,
  async register({ account, resolved, command, credentials, home, quota, observations }) {
    const ref = credentialRef(account.tokenRef ?? 'CLAUDE_CODE_OAUTH_TOKEN')
    if (!(await credentials.describe(ref)).configured) throw new Error(`token ${ref} is not configured (system credentials set ${ref})`)
    resolved.token = async () => (await credentials.resolve(ref))?.value
    const h = account.claudeHome ?? `claude/${account.ref.split('/')[1] ?? 'default'}`
    const claudeHome = isAbsolute(h) ? h : home(h)
    // The row owns this home: create it (mode 700) so the quota reader's cwd exists. A failure leaves the account registered; the quota reason names the directory.
    try { mkdirSync(claudeHome, { recursive: true, mode: 0o700 }) } catch { /* reported by the quota read */ }
    const cache = createQuotaCache({
      ...quota,
      seed: observations?.get(account.ref),
      // A failed write never fails an attempt.
      persist: (observed) => { observations?.put(account.ref, observed).catch(() => {}) },
      probe: async () => {
        const token = await resolved.token?.()
        return token ? probeClaudeQuota({ command, home: claudeHome, token, model: account.models?.economy, now: quota.now }) : []
      },
      read: async () => {
        const token = await resolved.token?.()
        return token ? readClaudeQuota({ command, home: claudeHome, token, now: quota.now }) : { unreadable: 'its token is not configured' }
      },
    })
    resolved.onRateLimit = (events) => cache.observe(events)
    return { quota: cache, providerAccount: readClaudeAccountId(claudeHome) }
  },
}
