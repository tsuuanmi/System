import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as cli from '../src/cli.ts'
import type { QuotaReport } from '../../agents/src/quota.ts'

// Resolve the planned export at runtime so the tests compile before it exists.
function quotaLine(report: QuotaReport, now: number): string {
  const format = Reflect.get(cli, 'quotaLine') as ((report: QuotaReport, now: number) => string) | undefined
  assert.equal(typeof format, 'function', 'cli exports quotaLine')
  return format!(report, now)
}
const now = new Date(2026, 10, 10, 12).getTime()
const observedAt = new Date(now - 120_000).toISOString()

test('quotaLine formats both windows, a local reset time and the reading age', () => {
  assert.equal(quotaLine({ observedAt, windows: {
    five_hour: { percentUsed: 18, resetsAt: new Date(2026, 10, 10, 23, 3).toISOString() },
    seven_day: { percentUsed: 10 },
  } }, now), 'quota: 5h 18% (resets 23:03), 7d 10%, read 2 min ago')
})

test('quotaLine omits an unreported five-hour window', () => {
  assert.equal(quotaLine({ observedAt, windows: { seven_day: { percentUsed: 10 } } }, now), 'quota: 7d 10%, read 2 min ago')
})

test('quotaLine shows why a reading is unreadable', () => {
  assert.equal(quotaLine({ unreadable: 'its CLI version 9.9.9 is not one checked' }, now), 'quota: unreadable - its CLI version 9.9.9 is not one checked')
})

test('quotaLine distinguishes a reset on a later local day', () => {
  const line = quotaLine({ observedAt, windows: { five_hour: { percentUsed: 18, resetsAt: new Date(2026, 10, 12, 23, 3).toISOString() } } }, now)
  assert.match(line, /\(resets [^)]*\S[^)]* 23:03\)/)
})

test('workers keeps account lines and prints exactly one quota line per account', async () => {
  const accounts = [
    { ref: 'codex/x1', runtime: 'codex', available: true, reason: 'registered', version: '0.166.0', capabilities: ['research'], models: { standard: 'test-model' }, quota: { observedAt, windows: { five_hour: { percentUsed: 18 } } } },
    { ref: 'web/chatgpt/x', runtime: 'web', available: false, reason: 'disabled', quota: { unreadable: 'a web account has no quota reader' } },
  ]
  let output = ''
  let run: cli.Run | undefined
  const program = cli.buildProgram({ workers: async () => ({ registered: ['codex/x1'], accounts }) } as unknown as cli.ClientHost, { out: (text: string) => { output += text } } as Parameters<typeof cli.buildProgram>[1], (selected) => { run = selected })
  program.exitOverride()
  await program.parseAsync(['node', 'system', 'workers'])
  assert.equal(await run!(), 0)
  assert.match(output, /^registered: codex\/x1\n/)
  assert.ok(output.includes(`${'codex/x1'.padEnd(22)} available   0.166.0  [provider account: unknown] (codex)\n`))
  assert.ok(output.includes(`${'web/chatgpt/x'.padEnd(22)} unavailable  - disabled (web)\n`))
  assert.match(output, /  capabilities: research\n  models: standard=test-model\n/)
  const blocks = output.trimEnd().split(/\n(?=\S)/).slice(1)
  assert.equal(blocks.length, 2)
  for (const block of blocks) assert.equal(block.match(/^  quota:/gm)?.length ?? 0, 1)
  assert.match(blocks[0]!, /  quota: 5h 18%, read /)
  assert.match(blocks[1]!, /  quota: unreadable - a web account has no quota reader/)
})


test('quotaLine names an event reading', () => {
  // Structural assignment permits the planned optional source before the type gains it.
  const reading = { observedAt, source: 'rate_limit_event' as const, windows: {
    five_hour: { percentUsed: 43 }, seven_day: { percentUsed: 31 },
  } }
  assert.equal(quotaLine(reading, now), 'quota: 5h 43%, 7d 31%, read 2 min ago (from the last attempt)')
})
