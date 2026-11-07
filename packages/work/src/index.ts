/**
 * The `work` row: provides `ctx.capabilities` (the Worker and verifier
 * registry) and `ctx.work` (what the Host core is built over) over the DSH
 * storage domain `system_work`, one key per Work (ADR-0004 decision 9).
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Artifacts, Envelope } from '@system/artifacts'
import { SPEC_KIND, SPEC_SCHEMA_VERSION, resolvedSpecSchema, type SpecStore, type WorkTable } from './controller.ts'
import { CONVERSATION_KIND, addConversation, conversationSchema, type Asserted, type ConversationParts } from './conversation.ts'
import { snapshot } from './git.ts'
import { WorkError } from './errors.ts'
import { Host } from './host.ts'
import { CHARTER_PATH, goalStore } from './goal.ts'
import { GIT_TREE_KIND, GOAL_KIND, TASK_KIND, VERDICT_KIND, gitTreeSchema, goalSchema, taskSchema, verdictSchema, type Goal } from './kinds.ts'
import type { Caller } from './record.ts'
import { workRecordSchema } from './record.ts'
import { Capabilities } from './registry.ts'
import type { ResolvedSpec } from './workflow.ts'

export * from './control.ts'
export * from './controller.ts'
export * from './conversation.ts'
export * from './errors.ts'
export * from './goal.ts'
export * from './git.ts'
export * from './host.ts'
export * from './host-lock.ts'
export * from './kinds.ts'
export * from './lane.ts'
export * from './record.ts'
export * from './registry.ts'
export * from './slots.ts'
export * from './summary.ts'
export * from './workflow.ts'
/** The zod the Work schemas are built with, for the packages that validate the same shapes. */
export { z } from 'zod'
/** The Artifact ID schema and classifications, for the packages that validate the same shapes. */
export { CLASSIFICATIONS, contentIdSchema } from '@system/artifacts'

export const name = 'system-work'
export const inject = ['storageDomain', 'artifacts']

export const workDomain = defineDomain({
  name: 'system_work',
  version: 1,
  tables: { work: domainTable(workRecordSchema) },
})

/** What the Host core is built over: the row's own table and specs. */
export interface HostStorage {
  table: WorkTable
  specs: SpecStore
}

/** What the Host serves besides Works: inputs for Tasks, and the Host core itself. */
export class WorkService {
  private readonly capabilities: Capabilities
  private readonly artifacts: Artifacts
  private readonly storage: HostStorage

  constructor(capabilities: Capabilities, artifacts: Artifacts, storage: HostStorage) {
    this.capabilities = capabilities
    this.artifacts = artifacts
    this.storage = storage
  }

  /** The Host core over this row's table, specs and capabilities (PROP-0004 C1): takes the lock for `home`, then recovers. */
  startHost(home: string): Promise<Host> {
    return Host.start({ home, capabilities: this.capabilities, ...this.storage })
  }

  /**
   * Store a `task@1` input; with a repository, first snapshot `ref` there as a
   * `git-tree@1` Artifact the task starts from.
   */
  async newTask(instructions: string, repository: string | undefined, ref: string | undefined, caller: Caller, context: string[] = []): Promise<{ task: string; base?: string }> {
    const producer = { type: 'operator' as const, ref: caller.operatorId }
    let base: string | undefined
    if (repository) {
      const tree = await snapshot(repository, ref)
      base = (await this.artifacts.put({
        ...GIT_TREE_KIND, content: tree, subject: { type: 'git-commit', ref: tree.commit },
        classification: 'local-private', producer,
      })).id
    }
    const task = await this.artifacts.put({
      ...TASK_KIND, content: { instructions, ...(base ? { base } : {}), ...(context.length ? { context } : {}) }, inputs: [...(base ? [base] : []), ...context],
      classification: 'local-private', producer,
    })
    return { task: task.id, base }
  }

  /**
   * Store a `goal@1` the operator wrote. Without `context` it is the Charter,
   * stored as a file Artifact now. `supersedes` must name a stored Goal with no successor, so the chain stays linear.
   */
  async newGoal(goal: Omit<Goal, 'context'> & { context?: string[] }, supersedes: string | undefined, caller: Caller): Promise<{ id: string }> {
    if (supersedes && !this.storage.specs.goals?.get(supersedes)) throw new WorkError(`${supersedes} is not a stored Goal`)
    if (supersedes) {
      const [newer] = this.storage.specs.goals!.successors(supersedes)
      if (newer) throw new WorkError(`Goal ${supersedes} is already superseded by ${newer}; supersede the newest version`)
    }
    const producer = { type: 'operator' as const, ref: caller.operatorId }
    const context = goal.context ?? [(await this.artifacts.putBytes({
      kind: 'file', schemaVersion: 1, data: await readFile(CHARTER_PATH), mediaType: 'text/markdown', classification: 'operator-shared', producer,
    })).id]
    const stored = await this.artifacts.put({
      ...GOAL_KIND, content: { ...goal, context }, inputs: context, ...(supersedes ? { supersedes: [supersedes] } : {}),
      classification: 'operator-shared', producer,
    })
    return { id: stored.id }
  }

  /** Store a conversation the operator had elsewhere (PROP-0003). */
  addConversation(parts: ConversationParts, asserted: Asserted, supersedes: string[], caller: Caller): Promise<Envelope> {
    return addConversation(this.artifacts, parts, asserted, { producer: { type: 'operator', ref: caller.operatorId }, supersedes })
  }
}

function specStore(artifacts: Artifacts): SpecStore {
  artifacts.registerKind({ kind: SPEC_KIND, schemaVersion: SPEC_SCHEMA_VERSION, content: resolvedSpecSchema })
  return {
    async putSpec(spec, caller) {
      const envelope = await artifacts.put({
        kind: SPEC_KIND, schemaVersion: SPEC_SCHEMA_VERSION, content: spec,
        classification: 'operator-shared', producer: { type: 'operator', ref: caller.operatorId },
      })
      return envelope.id
    },
    getSpec(specId) {
      const read = artifacts.get(specId)
      return read.state === 'stored' && read.envelope.kind === SPEC_KIND ? read.envelope.content as ResolvedSpec : undefined
    },
    exists: (id) => artifacts.get(id).state === 'stored',
    kindOf(id) {
      const read = artifacts.get(id)
      return read.state === 'stored' ? read.envelope.kind : undefined
    },
    goals: goalStore(artifacts),
    async putVerdict(verdict) {
      return (await artifacts.put({
        ...VERDICT_KIND, content: verdict, inputs: [verdict.subject, verdict.criteria, ...verdict.evidence],
        subject: { type: 'artifact', ref: verdict.subject },
        classification: 'operator-shared', producer: { type: 'verifier', ref: verdict.verifier.ref },
      })).id
    },
  }
}

/** `$DSH_HOME`: the launcher's home resolver when present. */
export function dshHome(ctx: Context): string {
  const homePath = ctx.get('dshHomePath' as never) as ((...s: string[]) => string) | undefined
  return homePath ? homePath() : process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** `$DSH_HOME/system/...`: the launcher's home resolver when present. */
export function systemPath(ctx: Context, ...segments: string[]): string {
  const homePath = ctx.get('dshHomePath' as never) as ((...s: string[]) => string) | undefined
  return homePath ? homePath('system', ...segments) : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'system', ...segments)
}

export async function apply(ctx: Context): Promise<void> {
  const domains = ctx.get('storageDomain') as DomainFacility
  const domain = await domains.open(workDomain)
  ctx.effect(() => () => { void domain.close() }, 'system_work domain')
  const artifacts = ctx.get('artifacts') as Artifacts
  artifacts.registerKind({ ...TASK_KIND, content: taskSchema })
  artifacts.registerKind({ ...GIT_TREE_KIND, content: gitTreeSchema })
  artifacts.registerKind({ ...VERDICT_KIND, content: verdictSchema })
  artifacts.registerKind({ ...GOAL_KIND, content: goalSchema })
  artifacts.registerKind({ ...CONVERSATION_KIND, content: conversationSchema })
  const capabilities = new Capabilities()
  const table = domain.table('work') as unknown as WorkTable
  const specs = specStore(artifacts)
  ctx.provide('capabilities', capabilities)
  ctx.provide('work', new WorkService(capabilities, artifacts, { table, specs }))
}
