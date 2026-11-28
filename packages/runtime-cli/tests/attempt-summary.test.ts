/** The attempt summary System computes from a Claude Code stream-json log. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeAttempt } from '../src/adapters/index.ts'

const line = (event: unknown) => JSON.stringify(event)
const use = (id: string, name: string, input: Record<string, unknown>) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const beat = (id: string, seconds: number, parent: string | null = null) => line({ type: 'tool_progress', tool_use_id: id, parent_tool_use_id: parent, tool_name: 'x', elapsed_time_seconds: seconds })

const log = [
  line({ type: 'system', subtype: 'init' }),
  use('t1', 'Read', { file_path: '/w/a.ts' }),
  use('t2', 'Read', { file_path: '/w/a.ts' }),
  use('t3', 'Read', { file_path: '/w/b.ts' }),
  use('t4', 'Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' }),
  use('t5', 'Write', { file_path: '/w/c.ts', content: '' }),
  use('t6', 'Bash', { command: `pnpm test ${'x'.repeat(200)}` }),
  beat('t6', 10), beat('t6', 20), beat('t6', 30),
  use('t7', 'Bash', { command: 'git status' }),
  beat('t7', 5), beat('t7', 6),
  'not json',
  line({ type: 'result', is_error: false, duration_ms: 100_000, num_turns: 7, result: 'ok' }),
].join('\n')

test('a Claude Code log gives exact counts, files and durations', () => {
  const s = summarizeAttempt('claude-code', log)
  assert.deepEqual(s.toolCalls, { Read: 3, Edit: 1, Write: 1, Bash: 2 })
  assert.deepEqual(s.filesRead, ['/w/a.ts', '/w/b.ts'])
  assert.deepEqual(s.filesEdited, ['/w/a.ts', '/w/c.ts'])
  assert.deepEqual(s.longest, [
    { tool: 'Bash', seconds: 30, command: `pnpm test ${'x'.repeat(200)}`.slice(0, 120) },
    { tool: 'Bash', seconds: 6, command: 'git status' },
  ])
  assert.equal(s.toolSeconds, 36)
  assert.equal(s.toolShare, 0.36)
  assert.equal(s.durationMs, 100_000)
  assert.equal(s.numTurns, 7)
})

test('a truncated log still parses, and what it lacks is unknown', () => {
  const cut = log.slice(log.indexOf('"t3"') - 60, log.indexOf('"t6"') + 20)
  const s = summarizeAttempt('claude-code', cut)
  assert.deepEqual(s.toolCalls, { Edit: 1, Write: 1 }, 'the lines cut at both ends are skipped')
  assert.equal(s.toolShare, 'unknown')
  assert.equal(s.durationMs, 'unknown')
  assert.equal(s.numTurns, 'unknown')
})

test('a Codex log gives what can be read and unknown for the rest', () => {
  const codex = [
    line({ type: 'thread.started' }),
    line({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }),
    line({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
  ].join('\n')
  const s = summarizeAttempt('codex', codex)
  assert.deepEqual(s.toolCalls, { command_execution: 1 })
  assert.equal(s.filesRead, 'unknown')
  assert.equal(s.filesEdited, 'unknown')
  assert.deepEqual(s.longest, [])
  assert.equal(s.toolSeconds, 'unknown')
  assert.equal(s.numTurns, 'unknown')
})

test('a web run has nothing to read', () => {
  assert.equal(summarizeAttempt('web', '').toolCalls, 'unknown')
})

test('overlapping tool calls sum their seconds: the ratio is tool-seconds per second and can pass 1', () => {
  const s = summarizeAttempt('claude-code', [use('a', 'Bash', { command: 'x' }), use('b', 'Bash', { command: 'y' }), beat('a', 10), beat('b', 10), line({ type: 'result', duration_ms: 15_000 })].join('\n'))
  assert.equal(s.toolSeconds, 20)
  assert.equal(s.toolShare, 1.33)
})

test('a stream with no tools has no tool seconds per second', () => {
  const s = summarizeAttempt('claude-code', line({ type: 'result', duration_ms: 15_000 }))
  assert.equal(s.toolSeconds, 'unknown')
  assert.equal(s.toolShare, 0)
})
