/**
 * cls-5: the cross-Work fact. A failure of a check on change C is not a failure of the change when C's tree passed the same
 * check later, in the same Work (after a re-run) or in a later Work whose checked change has the same tree. Read from the
 * Host's records only; report-only (nothing routes, retries or holds on it).
 */
import type { WorkRecord } from './record.ts'

/** A later pass of the same change content. */
export interface LaterPassed { work: string; check: string }
/**
 * The pass of `change` after event `index` of `record`: of `check` when given (a failed check), of any check otherwise (a
 * "no change" attempt whose previous change was kept). Undefined when the change never passed after it.
 */
export type LaterPass = (change: string, check: string | undefined, record: WorkRecord, index: number) => LaterPassed | undefined

/**
 * The lookup over `records`. `treeOf` maps a change Artifact ID to the identity of its tree (the `git-tree@1` content's tree)
 * when the caller can read it; without it a change is its Artifact ID, which already names one repository, commit and tree.
 */
export function laterPasses(records: readonly WorkRecord[], treeOf: (change: string) => string = (c) => c): LaterPass {
  const passes = new Map<string, { work: string; check: string; at: number; index: number }[]>()
  for (const record of records) {
    for (const [index, e] of record.events.entries()) {
      if (e.type !== 'verified' || e.verdict !== 'pass') continue
      const key = treeOf(e.subject)
      const list = passes.get(key) ?? []
      list.push({ work: record.id, check: e.stepId, at: Date.parse(e.at), index })
      passes.set(key, list)
    }
  }
  return (change, check, record, index) => {
    const failedAt = Date.parse(record.events[index]!.at)
    const found = passes.get(treeOf(change))?.find((p) => (check === undefined || p.check === check) && (p.work === record.id ? p.index > index : p.at > failedAt))
    return found && { work: found.work, check: found.check }
  }
}
