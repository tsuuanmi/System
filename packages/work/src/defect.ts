/**
 * `escaped-defect@1` (Item ms-1): a defect that reached `dev` or a release after the Item that carried it was verified and
 * merged, recorded so `work report` counts Escaped defects from records. It names the Item (by ID) or the merge commit
 * (a hex prefix of at least 7 characters), who or what found it, why it is a defect, and when.
 *
 * Artifacts are immutable, so a wrong record is corrected by a new one (Item def-2): an `escaped-defect@1` with `supersedes`
 * (an earlier defect it replaces, like `intent@1` in-1), or an `escaped-defect-withdrawal@1` {withdraws, reason, date}. The
 * withdrawal is its own kind because a withdrawal has no Item or commit, and putting `withdraws` on `escaped-defect@1` would
 * make `item`/`commit` optional there and weaken its exactly-one rule. `work report` counts only defects neither
 * superseded nor withdrawn.
 */
import { contentIdSchema, type Artifacts, type Envelope } from '@system/artifacts'
import { z } from 'zod'
import { WorkError } from './errors.ts'
import { ITEM_ID } from './status-parse.ts'
import { requireStored, storedOf } from './stored.ts'

export const DEFECT_KIND = { kind: 'escaped-defect', schemaVersion: 1 } as const
export const COMMIT_PREFIX = /^[0-9a-f]{7,40}$/
export const defectSchema = z.object({
  /** The Item (its ID in STATUS.md) that carried the defect; exactly one of `item` and `commit`. */
  item: z.string().regex(ITEM_ID).optional(),
  /** The merge commit that carried it (a hex prefix of at least 7 characters). */
  commit: z.string().regex(COMMIT_PREFIX).optional(),
  /** The Work ID that found it, or free text. */
  foundBy: z.string().min(1).max(500),
  reason: z.string().min(1).max(8 * 1024),
  /** When it was found (ISO date or timestamp). */
  date: z.string().min(10).max(40),
  /** The earlier `escaped-defect@1` Artifact this one replaces. */
  supersedes: contentIdSchema.optional(),
}).strict().refine((d) => (d.item === undefined) !== (d.commit === undefined), 'name exactly one of `item` and `commit`')
export type EscapedDefect = z.infer<typeof defectSchema>

export const WITHDRAWAL_KIND = { kind: 'escaped-defect-withdrawal', schemaVersion: 1 } as const
export const withdrawalSchema = z.object({
  /** The `escaped-defect@1` Artifact that was recorded wrongly. */
  withdraws: contentIdSchema,
  reason: z.string().min(1).max(8 * 1024),
  date: z.string().min(10).max(40),
}).strict()
export type DefectWithdrawal = z.infer<typeof withdrawalSchema>
/** A stored defect with its Artifact ID. */
export type StoredDefect = EscapedDefect & { id: string }

/** What a CLI or MCP caller gives: the subject as an Item ID or a commit, the date optional (now). */
export interface DefectInput { subject: string; foundBy: string; reason: string; date?: string; supersedes?: string }

/** The subject read as an Item ID or a commit prefix. */
export function defectSubject(subject: string): { item: string } | { commit: string } {
  if (ITEM_ID.test(subject)) return { item: subject }
  if (COMMIT_PREFIX.test(subject)) return { commit: subject }
  throw new WorkError(`${subject} is neither an Item ID nor a merge commit (7 to 40 lower-case hex characters)`)
}

/** Store an `escaped-defect@1`; `supersedes`, when given, must be a stored `escaped-defect@1`. */
export async function addDefect(artifacts: Artifacts, input: DefectInput, producer: { type: 'operator'; ref: string }, now: () => string = () => new Date().toISOString()): Promise<Envelope> {
  const content = defectSchema.parse({ ...defectSubject(input.subject), foundBy: input.foundBy, reason: input.reason, date: input.date ?? now(), ...(input.supersedes ? { supersedes: input.supersedes } : {}) })
  if (content.supersedes) requireStored(artifacts, content.supersedes, DEFECT_KIND, 'supersedes')
  return artifacts.put({ ...DEFECT_KIND, content, ...(content.supersedes ? { supersedes: [content.supersedes] } : {}), classification: 'local-private', producer })
}

/** Store an `escaped-defect-withdrawal@1`; `withdraws` must be a stored `escaped-defect@1`. */
export async function withdrawDefect(artifacts: Artifacts, input: { withdraws: string; reason: string; date?: string }, producer: { type: 'operator'; ref: string }, now: () => string = () => new Date().toISOString()): Promise<Envelope> {
  const content = withdrawalSchema.parse({ withdraws: input.withdraws, reason: input.reason, date: input.date ?? now() })
  requireStored(artifacts, content.withdraws, DEFECT_KIND, 'withdraws')
  return artifacts.put({ ...WITHDRAWAL_KIND, content, classification: 'local-private', producer })
}

/** Every stored `escaped-defect@1`, with its ID, for `rangeReport`. */
export function storedDefects(artifacts: Artifacts): StoredDefect[] {
  return storedOf<EscapedDefect>(artifacts, DEFECT_KIND.kind).map(({ id, content }) => ({ ...content, id }))
}

/** Every stored `escaped-defect-withdrawal@1`, for `rangeReport`. */
export function storedWithdrawals(artifacts: Artifacts): DefectWithdrawal[] {
  return storedOf<DefectWithdrawal>(artifacts, WITHDRAWAL_KIND.kind).map((s) => s.content)
}
