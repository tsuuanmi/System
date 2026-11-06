import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClaude, parseCodex } from '../src/runtimes.ts'

const line = (value: unknown) => JSON.stringify(value)

test('Codex usage is summed over completed turns', () => {
  const out = [line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }), line({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } })].join('\n')
  assert.deepEqual(parseCodex(out).usage, { inputTokens: 15, outputTokens: 3, source: 'codex turn.completed usage over 2 turn(s) (input includes cached)' })
})

test('a Codex turn without token counts makes usage unknown, never zero', () => {
  const out = [line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }), line({ type: 'turn.completed', usage: { input_tokens: 5 } })].join('\n')
  assert.equal(parseCodex(out).usage, undefined)
  assert.equal(parseCodex(line({ type: 'turn.completed' })).usage, undefined)
})

test('Claude Code usage without both token counts is unknown', () => {
  assert.equal(parseClaude(line({ is_error: false, result: 'ok', usage: { input_tokens: 3 } })).usage, undefined)
  assert.deepEqual(parseClaude(line({ is_error: false, result: 'ok', usage: { input_tokens: 3, output_tokens: 4 } })).usage, { inputTokens: 3, outputTokens: 4, source: 'claude-code result.usage (input includes cache reads and writes)' })
})
