/**
 * What an attempt did, computed by System from the attempt's own output (fl-4): tool calls by name, the files read and
 * edited, the longest tool calls and the share of the attempt's time spent in tools. Pure: no clock, no I/O. A Runtime
 * whose log does not say something reports `unknown` for it, never a guess. Also the bound of the stored log: its head and its tail.
 */
import type { AttemptSummary } from '@system/work'

/** The stored log's size: the first `HEAD_LOG_BYTES` (where the attempt reads the code) and the rest from the end. */
export const MAX_LOG_BYTES = 256 * 1024
export const HEAD_LOG_BYTES = 64 * 1024
const MAX_FILES = 200
const MAX_LONGEST = 5
const COMMAND_CHARS = 120

/** The head and the tail of `output` with a marker line for the cut; `output` itself when it fits. */
export function boundLog(output: string): string {
  if (output.length <= MAX_LOG_BYTES) return output
  const marker = (cut: number) => `\n[… ${cut} bytes cut by System …]\n`
  const reserve = marker(output.length).length + 8
  const headEnd = output.lastIndexOf('\n', HEAD_LOG_BYTES) + 1 || HEAD_LOG_BYTES
  const tailBytes = MAX_LOG_BYTES - headEnd - reserve
  let tailStart = output.length - tailBytes
  const newline = output.indexOf('\n', tailStart)
  if (newline >= 0 && newline - tailStart < 4096) tailStart = newline + 1
  return output.slice(0, headEnd) + marker(tailStart - headEnd) + output.slice(tailStart)
}

const UNKNOWN = 'unknown' as const

const events = (output: string): Array<Record<string, any>> => {
  const found: Array<Record<string, any>> = []
  for (const text of output.split('\n')) {
    if (!text.startsWith('{')) continue
    try {
      const event = JSON.parse(text)
      if (event && typeof event === 'object') found.push(event)
    } catch { /* a line cut by truncation, or not JSON */ }
  }
  return found
}

export function summarizeAttempt(runtime: 'claude-code' | 'codex' | 'web', output: string): AttemptSummary {
  const unknown: AttemptSummary = { runtime, toolCalls: UNKNOWN, filesRead: UNKNOWN, filesEdited: UNKNOWN, longest: [], toolSeconds: UNKNOWN, toolShare: UNKNOWN, durationMs: UNKNOWN, numTurns: UNKNOWN }
  if (runtime === 'web') return unknown
  if (runtime === 'codex') {
    const toolCalls: Record<string, number> = {}
    for (const event of events(output)) {
      const item = event.item
      if (event.type === 'item.completed' && item?.type === 'command_execution') toolCalls.command_execution = (toolCalls.command_execution ?? 0) + 1
    }
    return { ...unknown, toolCalls }
  }
  const toolCalls: Record<string, number> = {}
  const read = new Set<string>()
  const edited = new Set<string>()
  const calls = new Map<string, { tool: string; command?: string }>()
  const elapsed = new Map<string, { tool: string; seconds: number }>()
  let durationMs: number | undefined
  let numTurns: number | undefined
  for (const event of events(output)) {
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
  const share = durationMs ? Math.round((toolSeconds / (durationMs / 1000)) * 100) / 100 : UNKNOWN
  return {
    runtime, toolCalls, filesRead: [...read].slice(0, MAX_FILES), filesEdited: [...edited].slice(0, MAX_FILES), longest,
    toolSeconds: Object.keys(toolCalls).length || elapsed.size ? toolSeconds : UNKNOWN, toolShare: share,
    durationMs: durationMs ?? UNKNOWN, numTurns: numTurns ?? UNKNOWN,
  }
}
