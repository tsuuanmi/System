/** Synthetic quota answers and a private fake CLI/log per caller directory; never reads real accounts. */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function claudeUsage({ five_hour, seven_day, extra = {} }: { five_hour?: unknown; seven_day?: unknown; extra?: Record<string, unknown> } = {}) {
  return { rate_limits_available: true, rate_limits: { five_hour, seven_day, ...extra } }
}
export function codexRateLimits({ primary, secondary }: { primary?: unknown; secondary?: unknown } = {}) {
  return { rateLimits: { limitId: 'synthetic', credits: { hasCredits: false }, planType: 'test', ordinaryUsageAllowed: true, primary, secondary } }
}
export function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object')
  return value as Record<string, unknown>
}
export type LogEntry = Record<string, unknown>
export interface FakeQuotaOptions {
  kind: 'claude' | 'codex'
  version: string
  answer: unknown
  mode?: 'error' | 'garbage' | 'exit' | 'hang'
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
export function fakeQuotaCli(dir: string, options: FakeQuotaOptions) {
  mkdirSync(dir, { recursive: true })
  const command = join(dir, options.kind)
  const log = join(dir, 'log.jsonl')
  const answer = join(dir, 'answer.json')
  writeFileSync(answer, JSON.stringify(options.answer))
  const args = [process.execPath, fileURLToPath(new URL('./fake-quota-cli.mjs', import.meta.url)), `--fake-kind=${options.kind}`, `--fake-version=${options.version}`, `--fake-answer=${answer}`, `--fake-log=${log}`, `--fake-mode=${options.mode ?? ''}`]
  writeFileSync(command, `#!/bin/sh\nunset PWD SHLVL _\nexec ${args.map(quote).join(' ')} "$@"\n`)
  chmodSync(command, 0o700)
  return { command, log, readLog: (): LogEntry[] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => object(JSON.parse(line) as unknown)) }
}
