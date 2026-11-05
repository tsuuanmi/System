/**
 * The Artifact kinds Work admits as inputs, registered by the `work` row.
 *
 * - `task@1`: what to do, and optionally the exact repository commit to do it on.
 * - `git-tree@1`: one commit in one repository, with its tree; the subject of
 *   a code change (ADR-0003: a branch name or path is never the identity).
 */
import { z } from 'zod'

const sha = z.string().regex(/^[0-9a-f]{40}$/)
const artifactId = z.string().regex(/^sha256:[0-9a-f]{64}$/)

export const TASK_KIND = { kind: 'task', schemaVersion: 1 } as const
export const taskSchema = z.object({
  instructions: z.string().min(1).max(64 * 1024),
  /** A `git-tree@1` Artifact the Worker starts from. */
  base: artifactId.optional(),
}).strict()
export type Task = z.infer<typeof taskSchema>

export const GIT_TREE_KIND = { kind: 'git-tree', schemaVersion: 1 } as const
export const gitTreeSchema = z.object({
  repository: z.string().startsWith('/'),
  commit: sha,
  tree: sha,
  parent: sha.optional(),
}).strict()
export type GitTreeContent = z.infer<typeof gitTreeSchema>

/** A verdict, stored by the controller and bound to its exact subject and criteria. */
export const VERDICT_KIND = { kind: 'verdict', schemaVersion: 1 } as const
export const verdictSchema = z.object({
  subject: artifactId,
  criteria: artifactId,
  capability: z.string(),
  verifier: z.object({ ref: z.string(), version: z.string() }).strict(),
  verdict: z.enum(['pass', 'fail', 'inconclusive', 'error']),
  reason: z.string(),
  evidence: z.array(artifactId),
}).strict()
export type Verdict = z.infer<typeof verdictSchema>
