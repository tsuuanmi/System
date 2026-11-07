import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClaude, parseCodex, progressReader } from '../src/runtimes.ts'

const line = (value: unknown) => JSON.stringify(value)

test('Codex usage is summed over completed turns, cache read apart and no cache write', () => {
  const out = [line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }), line({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 } })].join('\n')
  assert.deepEqual(parseCodex(out).usage, { inputTokens: 15, cacheReadTokens: 4, outputTokens: 3, source: 'codex turn.completed usage over 2 turn(s) (input_tokens includes cached_input_tokens)' })
})

test('Codex usage without cached_input_tokens in every turn has no cache split', () => {
  const out = [line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }), line({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } })].join('\n')
  assert.deepEqual(parseCodex(out).usage, { inputTokens: 15, outputTokens: 3, source: 'codex turn.completed usage over 2 turn(s) (input_tokens includes cached_input_tokens)' })
})

test('a Codex turn without token counts makes usage unknown, never zero', () => {
  const out = [line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }), line({ type: 'turn.completed', usage: { input_tokens: 5 } })].join('\n')
  assert.equal(parseCodex(out).usage, undefined)
  assert.equal(parseCodex(line({ type: 'turn.completed' })).usage, undefined)
})

const SOURCE = (n: number) => `claude-code usage (excludes subagents) over ${n} result(s) (input_tokens is fresh; total adds cache_creation and cache_read); cost is a client-side API-equivalent estimate`
const MODEL_SOURCE = (n: number) => `claude-code modelUsage (includes subagents) over ${n} result(s) (inputTokens is fresh; total adds cache_creation and cache_read); cost is a client-side API-equivalent estimate`
const tokens = (inputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, costUSD?: number) => ({ inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens, ...(costUSD === undefined ? {} : { costUSD }) })
const result = (usage: Record<string, number> | undefined, extra: Record<string, unknown> = {}) => line({ type: 'result', is_error: false, result: 'ok', usage, ...extra })

test('Claude Code usage without both token counts is unknown', () => {
  assert.equal(parseClaude(result({ input_tokens: 3 })).usage, undefined)
  assert.deepEqual(parseClaude(result({ input_tokens: 3, output_tokens: 4 })).usage, { inputTokens: 3, outputTokens: 4, source: SOURCE(1) })
  assert.deepEqual(parseClaude(result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 4 })).usage, { inputTokens: 33, cacheReadTokens: 20, cacheWriteTokens: 10, outputTokens: 4, source: SOURCE(1) })
})

test('Claude Code usage is summed over every result, such as the turn a background command starts', () => {
  const out = [
    line({ type: 'system', subtype: 'init' }),
    result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }),
    result({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, output_tokens: 6 }),
  ].join('\n')
  assert.deepEqual(parseClaude(out).usage, { inputTokens: 40, cacheReadTokens: 24, cacheWriteTokens: 12, outputTokens: 11, source: SOURCE(2) })
})

test('Claude Code tokens come from modelUsage, so a subagent\'s model is counted though result.usage excludes it', () => {
  const out = [
    result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }, { modelUsage: { main: tokens(3, 20, 10, 5, 0.5), subagent: tokens(100, 200, 50, 40, 0.25) } }),
    result({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, output_tokens: 6 }, { modelUsage: { main: tokens(1, 4, 2, 6, 0.125) } }),
  ].join('\n')
  assert.deepEqual(parseClaude(out).usage, { inputTokens: 33 + 350 + 7, cacheReadTokens: 224, cacheWriteTokens: 62, outputTokens: 51, costUsd: 0.875, source: MODEL_SOURCE(2) })
})

test('Claude Code modelUsage without costUSD in every model leaves cost absent; usage is the fallback only when modelUsage is absent', () => {
  const usage = { input_tokens: 1, output_tokens: 1 }
  const noCost = parseClaude(result(usage, { modelUsage: { main: tokens(7, 0, 0, 2), other: tokens(1, 0, 0, 1, 0.5) } })).usage
  assert.deepEqual(noCost, { inputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3, source: MODEL_SOURCE(1) })
  assert.deepEqual(parseClaude(result(usage, { modelUsage: {} })).usage, { inputTokens: 1, outputTokens: 1, source: SOURCE(1) })
  assert.deepEqual(parseClaude([result(usage, { modelUsage: { main: tokens(7, 0, 0, 2, 1) } }), result(usage)].join('\n')).usage, { inputTokens: 2, outputTokens: 2, source: SOURCE(2) })
})

test('Claude Code cost is the sum of every result\'s total_cost_usd, and absent unless every result reports it', () => {
  const usage = { input_tokens: 1, output_tokens: 1 }
  assert.equal(parseClaude([result(usage, { total_cost_usd: 0.5 }), result(usage, { total_cost_usd: 0.25 })].join('\n')).usage?.costUsd, 0.75)
  assert.equal(parseClaude([result(usage, { total_cost_usd: 0.5 }), result(usage)].join('\n')).usage?.costUsd, undefined)
  assert.equal(parseClaude(result(usage)).usage && 'costUsd' in parseClaude(result(usage)).usage!, false)
})

test('the last Claude Code result decides success and the message; served models are the union', () => {
  const usage = { input_tokens: 1, output_tokens: 1 }
  const failedLast = parseClaude([result(usage, { result: 'first', modelUsage: { b: {} } }), result(usage, { is_error: true, result: 'second', modelUsage: { a: {} } })].join('\n'))
  assert.equal(failedLast.ok, false)
  assert.equal(failedLast.message, 'second')
  assert.deepEqual(failedLast.servedModels, ['a', 'b'])
  const okLast = parseClaude([result(usage, { is_error: true, result: 'first' }), result(usage, { result: 'second' })].join('\n'))
  assert.equal(okLast.ok, true)
  assert.equal(okLast.message, 'second')
})

test('lines that are not JSON or not results are ignored', () => {
  const out = ['warning: not json', line({ type: 'assistant', usage: { input_tokens: 99, output_tokens: 99 } }), result({ input_tokens: 3, output_tokens: 4 }), '{"truncated'].join('\n')
  const parsed = parseClaude(out)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.usage, { inputTokens: 3, outputTokens: 4, source: SOURCE(1) })
})

test('a stream with no result is unreadable output', () => {
  const parsed = parseClaude([line({ type: 'system' }), 'garbage'].join('\n'))
  assert.equal(parsed.ok, false)
  assert.match(parsed.message, /^unreadable Claude Code output: /)
  assert.equal(parsed.usage, undefined)
})

test('Claude Code progress is read as the stream grows: turns are messages, tokens are fresh input, cache writes and output, input tokens include cache reads', () => {
  const read = progressReader('claude-code')
  const assistant = (id: string, tool: string | undefined, output: number) => line({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }, ...(tool ? [{ type: 'tool_use', name: tool }] : [])], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: output } } })
  let stdout = `${line({ type: 'system', subtype: 'init' })}\n${assistant('m1', 'Bash', 3)}\n`
  assert.deepEqual(read(stdout), { turns: 1, lastTool: 'Bash', tokens: 18, inputTokens: 115 })
  // A message streamed as several events is one turn, counted once; a half-written line waits for its end.
  const half = assistant('m2', 'Read', 4)
  stdout += `${assistant('m1', 'Bash', 3)}\n${half.slice(0, 20)}`
  assert.deepEqual(read(stdout), { turns: 1, lastTool: 'Bash', tokens: 18, inputTokens: 115 })
  stdout += `${half.slice(20)}\n${assistant('m3', undefined, 1)}\nnot json\n`
  assert.deepEqual(read(stdout), { turns: 3, lastTool: 'Read', tokens: 18 + 19 + 16, inputTokens: 3 * 115 })
})

test('Codex progress counts completed turns and their tokens', () => {
  const read = progressReader('codex')
  assert.deepEqual(read(`${line({ type: 'item.completed', item: { type: 'command_execution' } })}\n${line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } })}\n`), { turns: 1, lastTool: 'command_execution', tokens: 8, inputTokens: 10 })
})
