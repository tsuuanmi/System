/**
 * The `work` row: provides `ctx.capabilities` (the Worker and verifier
 * registry) and `ctx.work` (what the Host core is built over) over the DSH
 * storage domain `system_work`, one key per Work (ADR-0004 decision 9).
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Artifacts, Envelope } from '@system/artifacts/contract'
import { SPEC_KIND, SPEC_SCHEMA_VERSION, resolvedSpecSchema, type SpecStore, type WorkTable } from './controller.ts'
import { putVerdict } from './verification.ts'
import { CONVERSATION_KIND, conversationSchema } from './conversation.ts'
import { changedTests } from './changed-tests.ts'
import { freshBranch, snapshot } from './git.ts'
import { DEFECT_KIND, WITHDRAWAL_KIND, addDefect, defectSchema, storedDefects, storedWithdrawals, withdrawDefect, withdrawalSchema, type DefectInput, type DefectWithdrawal, type StoredDefect } from './defect.ts'
import { INTENT_KIND, addIntent, intentSchema, storedIntents, type Intent } from './intent.ts'
import { CONFIRMATION_KIND, addConfirmation, confirmationSchema, storedConfirmations, type ConfirmationInput } from './confirmation.ts'
import { readStatus, type ClaimTable } from './gate.ts'
import { WorkError } from './errors.ts'
import { Host } from './host.ts'
import { DEFAULT_STALL_MINUTES } from './live.ts'
import { GIT_TREE_KIND, TASK_KIND, VERDICT_KIND, gitTreeSchema, taskSchema, verdictSchema, type GitTreeContent, type Task, type Verdict } from './kinds.ts'
import type { Caller } from './record.ts'
import { claimSchema, workRecordSchema } from './record.ts'
import { Capabilities } from './registry.ts'
import type { ResolvedSpec } from './workflow.ts'

export * from './controller.ts'
export * from './verification.ts'
export * from './conversation.ts'
export * from './errors.ts'
export * from './usage.ts'
export * from './gate.ts'
export * from './gates.ts'
export * from './git.ts'
export * from './home.ts'
export * from './changed-tests.ts'
export * from './host.ts'
export * from './host-lock.ts'
export * from './intent.ts'
export * from './defect.ts'
export * from './confirmation.ts'
export * from './core-lines.ts'
export * from './late-checks.ts'
export * from './releases.ts'
export * from './kinds.ts'
export * from './lane.ts'
export * from './headroom.ts'
export * from './live.ts'
export * from './record.ts'
export * from './registry.ts'
export * from './slots.ts'
export * from './status.ts'
export * from './measures.ts'
export * from './later-pass.ts'
export { defaultChange } from './failure-class.ts'
export * from './summary.ts'
export * from './outside.ts'
export * from './hold.ts'
export * from './workflow.ts'
/** The zod the Work schemas are built with, for the packages that validate the same shapes. */
export { z } from 'zod'
/** The Artifact ID schema and classifications, for the packages that validate the same shapes. */
export { CLASSIFICATIONS, contentIdSchema } from '@system/artifacts/contract'

export const name = 'system-work'
export const inject = ['storageDomain', 'artifacts']

export const workDomain = defineDomain({
  name: 'system_work',
  version: 1,
  tables: { work: domainTable(workRecordSchema), claims: domainTable(claimSchema) },
})

/** The row's configuration. */
export interface Config {
  /** How long a running attempt may be quiet before the Host reports it stalled; default `DEFAULT_STALL_MINUTES` (10). */
  stallMinutes: number
}
export const Config: Schema<Config> = Schema.object({ stallMinutes: Schema.number().min(0).default(DEFAULT_STALL_MINUTES) })

/** What the Host core is built over: the row's own table and specs. */
export interface HostStorage {
  table: WorkTable
  claims: ClaimTable
  specs: SpecStore
}

/** What the Host serves besides Works: inputs for Tasks, and the Host core itself. */
export class WorkService {
  private readonly capabilities: Capabilities
  private readonly artifacts: Artifacts
  private readonly storage: HostStorage
  private readonly config: Config

  constructor(capabilities: Capabilities, artifacts: Artifacts, storage: HostStorage, config: Config = { stallMinutes: DEFAULT_STALL_MINUTES }) {
    this.capabilities = capabilities
    this.artifacts = artifacts
    this.storage = storage
    this.config = config
  }

  /** The Host core over this row's table, specs and capabilities (PROP-0004 C1): takes the lock for `home`, then recovers. */
  startHost(home: string): Promise<Host> {
    return Host.start({ home, capabilities: this.capabilities, ...this.storage, stallMinutes: this.config.stallMinutes })
  }

  /** The Work table's keys and records, read-only, for the operator's store walk (`system doctor --store`). */
  records(): Pick<WorkTable, 'keys' | 'get'> {
    return this.storage.table
  }

  /** Store an `intent@1` Artifact: what the operator settled with a caller session. */
  async newIntent(intent: Intent, caller: Caller): Promise<{ intent: string }> {
    return { intent: (await addIntent(this.artifacts, intent, { type: 'operator', ref: caller.operatorId })).id }
  }

  /** Store an `escaped-defect@1` Artifact: a defect that escaped the Item or merge commit it names. */
  async newDefect(defect: DefectInput, caller: Caller): Promise<{ defect: string }> {
    return { defect: (await addDefect(this.artifacts, defect, { type: 'operator', ref: caller.operatorId })).id }
  }

  /** Store a `confirmation@1` Artifact: the operator confirmed the stored Artifact it names. */
  async newConfirmation(confirmation: ConfirmationInput, caller: Caller): Promise<{ confirmation: string }> {
    return { confirmation: (await addConfirmation(this.artifacts, confirmation, { type: 'operator', ref: caller.operatorId })).id }
  }

  /** The stored Intents and confirmations, for the operator acts of `rangeReport`. */
  operatorActs(): { intents: { at: string; settledBy?: 'operator' }[]; confirmations: { date: string }[] } {
    return { intents: storedIntents(this.artifacts), confirmations: storedConfirmations(this.artifacts) }
  }

  /** Store an `escaped-defect-withdrawal@1` Artifact: the defect it names was recorded wrongly. */
  async withdrawDefect(input: { withdraws: string; reason: string; date?: string }, caller: Caller): Promise<{ withdrawal: string }> {
    return { withdrawal: (await withdrawDefect(this.artifacts, input, { type: 'operator', ref: caller.operatorId })).id }
  }

  /** The recorded Escaped defects. */
  defects(): StoredDefect[] { return storedDefects(this.artifacts) }

  /** The recorded withdrawals of Escaped defects. */
  defectWithdrawals(): DefectWithdrawal[] { return storedWithdrawals(this.artifacts) }

  /**
   * Store a `task@1` input; with a repository, first snapshot `ref` there as a
   * `git-tree@1` Artifact the task starts from.
   */
  async newTask(instructions: string, repository: string | undefined, ref: string | undefined, caller: Caller, context: string[] = [], item?: string, against?: string): Promise<{ task: string; base?: string; note?: string }> {
    const producer = { type: 'operator' as const, ref: caller.operatorId }
    let base: string | undefined
    let intent: string | undefined
    if (item) {
      // Every Worker is told the Item's line, so an Item without one is refused here.
      if (!repository) throw new WorkError(`Item ${item} needs a repository: its line is read from STATUS.md on dev`)
      const status = await readStatus(repository)
      const line = status.items.find((i) => i.id === item)
      if (!line) throw new WorkError(`Item ${item} has no line in STATUS.md on ${status.ref} of ${status.repository}; add the line first`)
      if (line.intent) {
        // The Item's Intent travels with its Task as context, so every Worker reads what was wanted.
        const found = this.artifacts.idsByPrefix(INTENT_KIND.kind, line.intent)
        if (found.length !== 1) throw new WorkError(`Item ${item} names intent ${line.intent}, which matches ${found.length} stored intent@1 Artifacts (needs exactly one)`)
        intent = found[0]
      }
    }
    let note: string | undefined
    if (repository) {
      note = await freshBranch(repository, ref)
      const tree = await snapshot(repository, ref)
      // `against`: the commit this one is a change from; the verifier's touched files are the diff between the two.
      if (against) tree.parent = (await snapshot(repository, against)).commit
      base = (await this.artifacts.put({
        ...GIT_TREE_KIND, content: tree, subject: { type: 'git-commit', ref: tree.commit },
        classification: 'local-private', producer,
      })).id
    }
    if (intent && !context.includes(intent)) context = [...context, intent]
    const task = await this.artifacts.put({
      ...TASK_KIND, content: { instructions, ...(base ? { base } : {}), ...(context.length ? { context } : {}), ...(item ? { item } : {}) }, inputs: [...(base ? [base] : []), ...context],
      classification: 'local-private', producer,
    })
    return { task: task.id, base, ...(note ? { note } : {}) }
  }
}

export function specStore(artifacts: Artifacts, dispose?: (() => void)[]): SpecStore {
  dispose?.push(artifacts.registerKind({ kind: SPEC_KIND, schemaVersion: SPEC_SCHEMA_VERSION, content: resolvedSpecSchema }))
  /** The stored Artifact `id`, if it is stored and (when given) of `kind`. */
  const stored = (id: string, kind?: string): Envelope | undefined => {
    const read = artifacts.get(id)
    return read.state === 'stored' && (!kind || read.envelope.kind === kind) ? read.envelope : undefined
  }
  return {
    async putSpec(spec, caller) {
      const envelope = await artifacts.put({
        kind: SPEC_KIND, schemaVersion: SPEC_SCHEMA_VERSION, content: spec,
        classification: 'operator-shared', producer: { type: 'operator', ref: caller.operatorId },
      })
      return envelope.id
    },
    getSpec: (specId) => stored(specId, SPEC_KIND)?.content as ResolvedSpec | undefined,
    exists: (id) => artifacts.get(id).state === 'stored',
    kindOf: (id) => stored(id)?.kind,
    unchangedBase(id) {
      const tree = stored(id, GIT_TREE_KIND.kind)?.content as GitTreeContent | undefined
      return tree && tree.commit === tree.parent ? tree.commit : undefined
    },
    async changedTests(id, taskId) {
      const tree = stored(id, GIT_TREE_KIND.kind)?.content as GitTreeContent | undefined
      if (!tree) return undefined
      // tr-1: against the Task's base, whatever attempt produced the change; without one, the attempt's start.
      const task = taskId ? (stored(taskId, TASK_KIND.kind)?.content as Task | undefined) : undefined
      const taskBase = task?.base ? (stored(task.base, GIT_TREE_KIND.kind)?.content as GitTreeContent | undefined) : undefined
      const from = taskBase?.repository === tree.repository ? taskBase.commit : tree.parent
      return from ? changedTests(tree.repository, from, tree.commit) : undefined
    },
    commitOf: (id) => (stored(id, GIT_TREE_KIND.kind)?.content as GitTreeContent | undefined)?.commit,
    taskOf(id) {
      const task = stored(id, TASK_KIND.kind)?.content as Task | undefined
      if (!task) return undefined
      const base = task.base ? stored(task.base) : undefined
      return { task, ...(base ? { repository: (base.content as GitTreeContent).repository } : {}) }
    },
    async withNote(id, note, caller) {
      const task = stored(id)!.content as Task
      const producer = { type: 'operator' as const, ref: caller.operatorId }
      const text = await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: Buffer.from(note), mediaType: 'text/markdown', classification: 'local-private', producer })
      const context = [...(task.context ?? []), text.id]
      return (await artifacts.put({
        ...TASK_KIND, content: { ...task, context }, inputs: [...(task.base ? [task.base] : []), ...context],
        classification: 'local-private', producer,
      })).id
    },
    putVerdict: (verdict) => putVerdict(artifacts, verdict),
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const domains = ctx.get('storageDomain') as DomainFacility
  const domain = await domains.open(workDomain)
  ctx.effect(() => () => { void domain.close() }, 'system_work domain')
  const artifacts = ctx.get('artifacts') as Artifacts
  const dispose = [
    artifacts.registerKind({ ...TASK_KIND, content: taskSchema }),
    artifacts.registerKind({ ...INTENT_KIND, content: intentSchema }),
    artifacts.registerKind({ ...DEFECT_KIND, content: defectSchema }),
    artifacts.registerKind({ ...CONFIRMATION_KIND, content: confirmationSchema }),
    artifacts.registerKind({ ...WITHDRAWAL_KIND, content: withdrawalSchema }),
    artifacts.registerKind({ ...GIT_TREE_KIND, content: gitTreeSchema }),
    artifacts.registerKind({ ...VERDICT_KIND, content: verdictSchema }),
    artifacts.registerKind({ ...CONVERSATION_KIND, content: conversationSchema }),
  ]
  const capabilities = new Capabilities()
  const table = domain.table('work') as unknown as WorkTable
  const claims = domain.table('claims') as unknown as ClaimTable
  const specs = specStore(artifacts, dispose)
  ctx.effect(() => () => { for (const d of dispose) d() }, 'work kinds')
  ctx.provide('capabilities', capabilities)
  ctx.provide('work', new WorkService(capabilities, artifacts, { table, claims, specs }, config))
}
