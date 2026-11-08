/**
 * The Artifact kinds Work admits as inputs, registered by the `work` row.
 *
 * - `task@1`: what to do, and optionally the exact repository commit to do it on.
 * - `goal@1`: an aim, its scope and its budget, written by the operator (ADR-0009).
 * - `decision@1`: a choice made for a Goal, by the operator or an Orchestrator (PROP-0006).
 * - `git-tree@1`: one commit in one repository, with its tree; the subject of
 *   a code change (ADR-0003: a branch name or path is never the identity).
 */
import { contentIdSchema } from '@system/artifacts'
import { z } from 'zod'
import { callerSchema } from './record.ts'

const sha = z.string().regex(/^[0-9a-f]{40}$/)

export const TASK_KIND = { kind: 'task', schemaVersion: 1 } as const
export const taskSchema = z.object({
  instructions: z.string().min(1).max(64 * 1024),
  /** A `git-tree@1` Artifact the Worker starts from. */
  base: contentIdSchema.optional(),
  /** Artifacts the Worker reads as data, such as an ingested conversation (PROP-0003). */
  context: z.array(contentIdSchema).min(1).max(16).optional(),
}).strict()
export type Task = z.infer<typeof taskSchema>

export const GOAL_KIND = { kind: 'goal', schemaVersion: 1 } as const
export const goalSchema = z.object({
  aim: z.string().min(1).max(16 * 1024),
  scope: z.string().min(1).max(16 * 1024),
  /** What the Goal's Works may spend: attempts, and tokens (fresh input plus output). Absent means no limit. */
  budget: z.object({ attempts: z.number().int().positive().optional(), tokens: z.number().int().positive().optional() }).strict(),
  /** Artifacts every Work of the Goal receives as Task context. */
  context: z.array(contentIdSchema).min(1).max(16),
}).strict()
export type Goal = z.infer<typeof goalSchema>
/** A Goal as the operator writes it: without `context` the Charter is the context. */
export type NewGoal = Omit<Goal, 'context'> & { context?: string[] }

export const DECISION_KIND = { kind: 'decision', schemaVersion: 1 } as const
/** A record, never an authority: approving, denying and merging stay the operator's. */
export const decisionSchema = z.object({
  goal: contentIdSchema,
  question: z.string().min(1).max(4 * 1024),
  options: z.array(z.string().min(1).max(1024)).min(1).max(16),
  choice: z.string().min(1).max(1024),
  reason: z.string().min(1).max(16 * 1024),
  /** What it rests on, such as a synthesis, a review or a check-run. */
  restsOn: z.array(contentIdSchema).max(16),
  by: callerSchema,
  /** The decision of the Goal's chain recorded just before it: the order of a Goal's decisions. */
  previous: contentIdSchema.optional(),
}).strict()
export type RecordedDecision = z.infer<typeof decisionSchema>

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
  subject: contentIdSchema,
  criteria: contentIdSchema,
  capability: z.string(),
  verifier: z.object({ ref: z.string(), version: z.string() }).strict(),
  verdict: z.enum(['pass', 'fail', 'inconclusive', 'error']),
  reason: z.string(),
  evidence: z.array(contentIdSchema),
}).strict()
export type Verdict = z.infer<typeof verdictSchema>
