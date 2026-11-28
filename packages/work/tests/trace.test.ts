import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fold, traceWork, type TraceStore, type WorkEvent } from '@system/work/contract'

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const HASH_C = `sha256:${'c'.repeat(64)}`
const HASH_D = `sha256:${'d'.repeat(64)}`
const HASH_E = `sha256:${'e'.repeat(64)}`
const HASH_F = `sha256:${'f'.repeat(64)}`
const HASH_1 = `sha256:${'1'.repeat(64)}`
const HASH_2 = `sha256:${'2'.repeat(64)}`
const HASH_3 = `sha256:${'3'.repeat(64)}`
const HASH_4 = `sha256:${'4'.repeat(64)}`

function recordOf(events: WorkEvent[]) {
  return { id: 'work:trace-1', events, state: fold(events) }
}

function storeOf(artifacts: Record<string, { kind: string; content?: unknown; bytes?: string }>): TraceStore {
  return {
    artifact(id) {
      const entry = artifacts[id]
      if (!entry) return { state: 'missing' }
      return {
        state: 'stored',
        envelope: {
          kind: entry.kind,
          ...(entry.content !== undefined ? { content: entry.content } : {}),
          ...(entry.bytes !== undefined ? { blob: { bytes: Buffer.byteLength(entry.bytes) } } : {}),
        },
      }
    },
    async readBytes(id) {
      const entry = artifacts[id]
      if (!entry || entry.bytes === undefined) throw new Error(`no Artifact ${id}`)
      return Buffer.from(entry.bytes)
    },
  }
}

test('traceWork records attempts, logs across all three runtimes, failed checks, reopenings, effects, and terminal outcome in order', async () => {
  const claudeLog = [
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/a.ts' } },
          { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pnpm test' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'done',
      structured_output: { status: 'done', reason: 'updated src/a.ts' },
    }),
  ].join('\n')

  const codexLog = [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/b.ts', kind: 'update' }] } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'done', reason: 'fixed src/b.ts' }) } }),
  ].join('\n')

  const agyLog = [
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: '/repo/c.ts' } } } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: '/repo/c.ts' } } } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: '/repo/d.ts' } } } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'git status' } } } }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'all good' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify({ status: 'done', reason: 'verified agy' }) } }),
  ].join('\n')

  const plainLog = 'plain stdout line without structured events\n'

  const events: WorkEvent[] = [
    { type: 'admitted', seq: 1, at: '2026-11-28T00:00:00.000Z', caller: { type: 'agent', operatorId: 'op' }, specId: HASH_A, input: HASH_B, item: { id: 'trace-1', repository: '/repo' }, source: { kind: 'workflow-file' } },
    { type: 'dispatched', seq: 2, at: '2026-11-28T00:00:01.000Z', stepId: 'implement', attemptId: 'att-1', executor: 'worker', capability: 'repo.write', selected: 'claude-code/a', candidates: [{ ref: 'claude-code/a', selected: true, reason: 'ok' }], inputs: { task: HASH_B } },
    { type: 'observed', seq: 3, at: '2026-11-28T00:00:06.000Z', stepId: 'implement', attemptId: 'att-1', status: 'succeeded', outputs: { change: HASH_C }, usage: { state: 'observed', inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 10, outputTokens: 20, costUsd: 0.01, source: 's' }, log: HASH_1, worker: { ref: 'claude-code/a', model: 'sonnet', servedModels: ['claude-sonnet-4'] } },
    { type: 'dispatched', seq: 4, at: '2026-11-28T00:00:07.000Z', stepId: 'checks', attemptId: 'att-v1', executor: 'verifier', capability: 'code.required-checks', selected: 'checks', candidates: [{ ref: 'checks', selected: true, reason: 'ok' }], inputs: { subject: HASH_C } },
    { type: 'verified', seq: 5, at: '2026-11-28T00:00:10.000Z', stepId: 'checks', attemptId: 'att-v1', subject: HASH_C, criteria: HASH_D, verdict: 'fail', reason: 'unit failed', verdictId: HASH_E, evidence: [HASH_2] },
    { type: 'reopened', seq: 6, at: '2026-11-28T00:00:11.000Z', automatic: true, stepId: 'implement', reason: 'unit failed', previous: HASH_C, failure: HASH_E, reset: ['implement', 'checks'] },
    { type: 'dispatched', seq: 7, at: '2026-11-28T00:00:12.000Z', stepId: 'implement', attemptId: 'att-2', executor: 'worker', capability: 'repo.write', selected: 'codex/a', candidates: [{ ref: 'codex/a', selected: true, reason: 'ok' }], inputs: { task: HASH_B, previous: HASH_C, failure: HASH_E } },
    { type: 'observed', seq: 8, at: '2026-11-28T00:00:15.000Z', stepId: 'implement', attemptId: 'att-2', status: 'succeeded', outputs: { change: HASH_F }, usage: { state: 'observed', inputTokens: 50, cacheReadTokens: 20, outputTokens: 10, source: 's' }, log: HASH_3, worker: { ref: 'codex/a', model: 'gpt-5' } },
    { type: 'dispatched', seq: 9, at: '2026-11-28T00:00:16.000Z', stepId: 'review', attemptId: 'att-3', executor: 'worker', capability: 'review', selected: 'antigravity/a', candidates: [{ ref: 'antigravity/a', selected: true, reason: 'ok' }], inputs: { change: HASH_F } },
    { type: 'observed', seq: 10, at: '2026-11-28T00:00:20.000Z', stepId: 'review', attemptId: 'att-3', status: 'succeeded', outputs: { report: HASH_F }, usage: { state: 'unknown' }, log: HASH_4, worker: { ref: 'antigravity/a', model: 'gemini' } },
    { type: 'effect-intended', seq: 11, at: '2026-11-28T00:00:21.000Z', stepId: 'publish', operationId: 'op-1', capability: 'repo.publish', subject: HASH_F, params: {}, provider: { ref: 'github', version: '1' } },
    { type: 'effect-observed', seq: 12, at: '2026-11-28T00:00:22.000Z', stepId: 'publish', operationId: 'op-1', state: 'applied', reason: 'merged into dev', detail: { mergeCommit: 'abc1234' } },
    { type: 'terminal', seq: 13, at: '2026-11-28T00:00:23.000Z', outcome: 'succeeded', reason: 'done', results: { change: HASH_F } },
  ]

  const store = storeOf({
    [HASH_1]: { kind: 'file', bytes: claudeLog },
    [HASH_2]: { kind: 'check-run', content: { name: 'unit', run: 'pnpm test', commit: 'abc', exitCode: 1, signal: null, timedOut: false, durationMs: 100, stdoutTail: 'fail line 1', stderrTail: 'err line 1' } },
    [HASH_3]: { kind: 'file', bytes: codexLog },
    [HASH_4]: { kind: 'file', bytes: agyLog },
  })

  const trace = await traceWork(recordOf(events), store)
  assert.equal(trace.id, 'work:trace-1')
  assert.equal(trace.status, 'succeeded')
  assert.deepEqual(trace.timeline.map((e) => e.kind), ['attempt', 'verdict', 'reopened', 'attempt', 'attempt', 'effect', 'terminal'])

  const a1 = trace.timeline[0]!
  assert.equal(a1.kind, 'attempt')
  assert.equal(a1.account, 'claude-code/a')
  assert.equal(a1.model, 'claude-sonnet-4')
  assert.equal(a1.durationMs, 5000)
  assert.deepEqual(a1.log?.commands, ['pnpm test'])
  assert.deepEqual(a1.log?.filesRead, ['src/a.ts'])
  assert.deepEqual(a1.log?.filesWritten, ['src/a.ts'])
  assert.equal(a1.log?.finalStatement, 'done: updated src/a.ts')

  const v1 = trace.timeline[1]!
  assert.equal(v1.kind, 'verdict')
  assert.equal(v1.verdict, 'fail')
  assert.equal(v1.failedChecks.length, 1)
  assert.equal(v1.failedChecks[0]!.name, 'unit')
  assert.equal(v1.failedChecks[0]!.stdoutTail, 'fail line 1')
  assert.equal(v1.failedChecks[0]!.stderrTail, 'err line 1')

  const r1 = trace.timeline[2]!
  assert.equal(r1.kind, 'reopened')
  assert.equal(r1.previous, HASH_C)
  assert.equal(r1.failure, HASH_E)

  const a2 = trace.timeline[3]!
  assert.equal(a2.kind, 'attempt')
  assert.equal(a2.inputs?.previous, HASH_C)
  assert.equal(a2.inputs?.failure, HASH_E)
  assert.deepEqual(a2.log?.commands, ['npm test'])
  assert.deepEqual(a2.log?.filesWritten, ['src/b.ts'])
  assert.equal(a2.log?.finalStatement, 'done: fixed src/b.ts')

  const a3 = trace.timeline[4]!
  assert.equal(a3.kind, 'attempt')
  assert.deepEqual(a3.log?.commands, ['git status'])
  assert.deepEqual(a3.log?.filesRead, ['/repo/c.ts'])
  assert.deepEqual(a3.log?.filesWritten, ['/repo/d.ts'])
  assert.equal(a3.log?.finalStatement, 'done: verified agy')

  const eff = trace.timeline[5]!
  assert.equal(eff.kind, 'effect')
  assert.equal(eff.state, 'applied')
  assert.equal(eff.reason, 'merged into dev')

  assert.equal(trace.outcome?.outcome, 'succeeded')

  // An Attempt whose log has no recognized events keeps only the log's ID and size.
  const plainEvents: WorkEvent[] = [
    { type: 'admitted', seq: 1, at: '2026-11-28T00:00:00.000Z', caller: { type: 'agent', operatorId: 'op' }, specId: HASH_A, source: { kind: 'direct-task' } },
    { type: 'dispatched', seq: 2, at: '2026-11-28T00:00:01.000Z', stepId: 'task', attemptId: 'att-p', executor: 'worker', capability: 'c', selected: 'w/1', candidates: [{ ref: 'w/1', selected: true, reason: 'ok' }], inputs: {} },
    { type: 'observed', seq: 3, at: '2026-11-28T00:00:02.000Z', stepId: 'task', attemptId: 'att-p', status: 'succeeded', outputs: {}, usage: { state: 'unknown' }, log: HASH_1 },
    { type: 'terminal', seq: 4, at: '2026-11-28T00:00:03.000Z', outcome: 'succeeded', reason: 'ok', results: {} },
  ]
  const plainTrace = await traceWork(recordOf(plainEvents), storeOf({ [HASH_1]: { kind: 'file', bytes: plainLog } }))
  const plainAttempt = plainTrace.timeline[0]!
  assert.equal(plainAttempt.kind, 'attempt')
  assert.deepEqual(plainAttempt.log, { id: HASH_1, size: Buffer.byteLength(plainLog) })
})
