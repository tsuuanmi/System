/** Shared structured final-result schema and parser for Codex and Antigravity (finish-1, RES-0016). */
import type { FinalResult } from '@system/work'
import type { Parsed } from '../runtimes.ts'

export const FINAL_RESULT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    reason: { type: 'string' },
  },
  required: ['status', 'reason'],
  additionalProperties: false,
})

/** Parse a `{status: done|blocked, reason}` JSON string into a `FinalResult`, or return why it is missing/invalid. */
export function parseFinalResult(raw: string): { ok: true; finalResult: FinalResult } | { ok: false; message: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, message: 'missing structured final result' }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return { ok: false, message: 'invalid structured final result: not JSON' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'invalid structured final result: expected an object' }
  }
  const obj = value as Record<string, unknown>
  if ((obj.status !== 'done' && obj.status !== 'blocked') || typeof obj.reason !== 'string') {
    return { ok: false, message: 'invalid structured final result: expected {status: done|blocked, reason}' }
  }
  return { ok: true, finalResult: { status: obj.status, reason: obj.reason } }
}

/** Apply a structured final result to a `Parsed` CLI outcome. */
export function applyFinalResult(base: Parsed, raw: string | undefined): Parsed {
  if (raw === undefined) return { ...base, ok: false, message: 'missing structured final result' }
  const checked = parseFinalResult(raw)
  if (!checked.ok) return { ...base, ok: false, message: checked.message }
  const { finalResult } = checked
  if (finalResult.status === 'blocked') {
    return { ...base, ok: false, message: finalResult.reason || 'blocked', finalResult }
  }
  return { ...base, ok: true, message: finalResult.reason, finalResult }
}
