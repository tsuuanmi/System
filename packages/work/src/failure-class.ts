/**
 * The class of a failure for the Recurring Failure Rate (GLOSSARY: Recurring failure), from structure and never from
 * test names: a failure of the change is its check and first failing test, parsed here and nowhere else from the reason
 * System writes (`failed: <check>: <file> "<test>"`, see packages/verifiers/src/reasons.ts); an Outside failure is its
 * cause, except a flaky check failure, which keeps its check and test too (`flaky:<check>:<file> "<test>"`); a failure whose cause System cannot place is `unknown`.
 */
import type { Failure } from './summary.ts'

export interface CheckFailure { check: string; test?: string }

/**
 * The first failed check of a verdict reason and its first failing test: `failed: unit: a.test.ts "x": boom`, or, for a
 * timeout, the first test running then (`failed: smoke: timed out after 120 s while running s.test.ts "y"`).
 * A failure without a test names the check alone. Undefined when the reason is not a check failure.
 */
export function parseCheckFailure(reason: string): CheckFailure | undefined {
  const head = /^failed: ([^:;(]+?)(?:: | \(|;|$)/.exec(reason)
  if (!head) return undefined
  const rest = reason.slice(head[0].length)
  const test = /^[^\s"]+ "(.*?)"(?=: |;| \(|$)/.exec(rest)?.[0] ?? /^timed out after \d+ s while running ([^\s"]+ "(.*?)")(?=, |: |;| \(|$)/.exec(rest)?.[1]
  return { check: head[1]!, ...(test ? { test } : {}) }
}

/** The class of one failure (not a touch): the cause when Outside (`flaky` adds its check and test), `unknown`, else the check and first failing test, else the kind. */
export function failureClass(f: Pick<Failure, 'kind' | 'reason' | 'outside' | 'unknown'>): string {
  if (f.outside === 'flaky') {
    const parsed = parseCheckFailure(f.reason)
    return parsed ? `flaky:${parsed.check}:${parsed.test ?? ''}` : 'flaky'
  }
  if (f.outside) return f.outside
  if (f.unknown) return 'unknown'
  const parsed = parseCheckFailure(f.reason)
  return parsed ? `change:${parsed.check}:${parsed.test ?? ''}` : `change-${f.kind}`
}

/** cls-6: whether the rules' class of `f` is only the default `change`: nothing positive behind it (no failing test, no base pass in the reason). */
export function defaultChange(f: Pick<Failure, 'kind' | 'reason' | 'outside' | 'unknown'>): boolean {
  if (f.outside || f.unknown || f.kind === 'touch') return false
  return !parseCheckFailure(f.reason)?.test && !/\bthe base passed\b/i.test(f.reason)
}
