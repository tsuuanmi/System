/**
 * `release-approval@1` (Item rel-2, ADR-0019 decision 3): the Operator approved one commit of `dev` for release.
 * A caller session may then release that commit; `releasesBy` leaves such a release out of `releaseViolations`.
 */
import type { Artifacts, Envelope } from '@system/artifacts/contract'
import { z } from 'zod'
import { storedOf } from './stored.ts'

export const RELEASE_APPROVAL_KIND = { kind: 'release-approval', schemaVersion: 1 } as const
export const releaseApprovalSchema = z.object({
  /** The approved commit of `dev`: 7 to 40 lowercase hex characters, as typed at the confirmation. */
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  operator: z.string().min(1),
  at: z.string().min(10).max(40),
}).strict()
type ReleaseApproval = z.infer<typeof releaseApprovalSchema>

/** Store a `release-approval@1` for `input.commit`; the operator is the producer's ref. */
export async function addReleaseApproval(artifacts: Artifacts, input: { commit: string }, producer: { type: 'operator'; ref: string }, now: () => string = () => new Date().toISOString()): Promise<Envelope> {
  const content = releaseApprovalSchema.parse({ commit: input.commit.toLowerCase(), operator: producer.ref, at: now() })
  return artifacts.put({ ...RELEASE_APPROVAL_KIND, content, classification: 'local-private', producer })
}

export function storedReleaseApprovals(artifacts: Artifacts): ReleaseApproval[] {
  return storedOf<ReleaseApproval>(artifacts, RELEASE_APPROVAL_KIND.kind).map((s) => s.content)
}
