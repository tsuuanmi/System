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
