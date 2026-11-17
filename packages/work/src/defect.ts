/**
 * `escaped-defect@1` (Item ms-1): a defect that reached `dev` or a release after the Item that carried it was verified and
 * merged, recorded so `work report` counts Escaped defects from records. It names the Item (by ID) or the merge commit
 * (a hex prefix of at least 7 characters), who or what found it, why it is a defect, and when.
 */
import { type Artifacts, type Envelope } from '@system/artifacts'
import { z } from 'zod'
import { WorkError } from './errors.ts'
import { ITEM_ID } from './status-parse.ts'

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
}).strict().refine((d) => (d.item === undefined) !== (d.commit === undefined), 'name exactly one of `item` and `commit`')
export type EscapedDefect = z.infer<typeof defectSchema>

/** What a CLI or MCP caller gives: the subject as an Item ID or a commit, the date optional (now). */
export interface DefectInput { subject: string; foundBy: string; reason: string; date?: string }

/** The subject read as an Item ID or a commit prefix. */
export function defectSubject(subject: string): { item: string } | { commit: string } {
  if (ITEM_ID.test(subject)) return { item: subject }
  if (COMMIT_PREFIX.test(subject)) return { commit: subject }
  throw new WorkError(`${subject} is neither an Item ID nor a merge commit (7 to 40 lower-case hex characters)`)
}

/** Store an `escaped-defect@1`. */
export function addDefect(artifacts: Artifacts, input: DefectInput, producer: { type: 'operator'; ref: string }, now: () => string = () => new Date().toISOString()): Promise<Envelope> {
  const content = defectSchema.parse({ ...defectSubject(input.subject), foundBy: input.foundBy, reason: input.reason, date: input.date ?? now() })
  return artifacts.put({ ...DEFECT_KIND, content, classification: 'local-private', producer })
}

/** Every stored `escaped-defect@1`, for `rangeReport`. */
export function storedDefects(artifacts: Artifacts): EscapedDefect[] {
  const found: EscapedDefect[] = []
  for (const id of artifacts.idsByPrefix(DEFECT_KIND.kind, '')) {
    const read = artifacts.get(id)
    if (read.state === 'stored') found.push(read.envelope.content as EscapedDefect)
  }
  return found
}
