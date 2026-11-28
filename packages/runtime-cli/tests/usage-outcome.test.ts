/** usage-1: each Runtime's recorded usage outcome, from its fixtures. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { usageRecord } from '@system/work'
import { adapterFor } from '../src/adapters/index.ts'

const dir = dirname(fileURLToPath(import.meta.url))
const outcome = (runtime: 'claude-code' | 'codex' | 'antigravity', file: string) => {
  const parsed = adapterFor(runtime)!.parse(readFileSync(join(dir, 'fixtures', runtime, file), 'utf8'), { structured: false } as never)
  const record = usageRecord(parsed.usage, parsed.usageGap)
  return { outcome: record.outcome, origin: record.origin, reason: record.reason }
}

test('claude-code: tokens and cost are known; no cost is partial; no usage is unavailable with the reason', () => {
  assert.deepEqual(outcome('claude-code', 'stream-ok.jsonl'), { outcome: 'known', origin: 'stream', reason: undefined })
  assert.equal(outcome('claude-code', 'stream-no-cost.jsonl').outcome, 'partial')
  const none = outcome('claude-code', 'stream-no-usage.jsonl')
  assert.equal(none.outcome, 'unavailable')
  assert.equal(none.origin, 'none')
  assert.match(none.reason!, /claude-code/)
})

test('codex: the CLI reports no cost, so counted turns are partial; a stream with no usage is unavailable', () => {
  assert.deepEqual(outcome('codex', 'stream-done.jsonl'), { outcome: 'partial', origin: 'stream', reason: 'the Runtime reported no cost' })
  const none = outcome('codex', 'stream-no-usage.jsonl')
  assert.equal(none.outcome, 'unavailable')
  assert.match(none.reason!, /codex/)
})

test('antigravity: the result usage without cost is partial; a failed run is unavailable', () => {
  assert.equal(outcome('antigravity', 'stream-done.jsonl').outcome, 'partial')
  assert.equal(outcome('antigravity', 'stream-no-usage.jsonl').outcome, 'unavailable')
})
