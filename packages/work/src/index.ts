/**
 * The `work` row: provides `ctx.capabilities` (the Worker and verifier
 * registry) and `ctx.work` (admission and the Work Controller) over the DSH
 * storage domain `system_work`, one key per Work (ADR-0004 decision 9).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { sha256, type Artifacts } from '@system/artifacts'
import { FileControl } from './control.ts'
import { SPEC_KIND, SPEC_SCHEMA_VERSION, WorkController, resolvedSpecSchema, type SpecStore, type WorkTable } from './controller.ts'
import { snapshot } from './git.ts'
import { GIT_TREE_KIND, TASK_KIND, VERDICT_KIND, gitTreeSchema, taskSchema, verdictSchema } from './kinds.ts'
import type { Caller, WorkRecord } from './record.ts'
import { workRecordSchema } from './record.ts'
import { Capabilities } from './registry.ts'
import { directTask, parseWorkflow, resolve, type ResolvedSpec } from './workflow.ts'

export * from './control.ts'
export * from './controller.ts'
export * from './errors.ts'
export * from './git.ts'
export * from './kinds.ts'
export * from './record.ts'
export * from './registry.ts'
export * from './summary.ts'
export * from './workflow.ts'

export const name = 'system-work'
export const inject = ['storageDomain', 'artifacts']

export const workDomain = defineDomain({
  name: 'system_work',
  version: 1,
  tables: { work: domainTable(workRecordSchema) },
})

/** Admission entry points the CLI uses. */
export class WorkService {
  readonly controller: WorkController
  private readonly capabilities: Capabilities
  private readonly artifacts: Artifacts

  constructor(controller: WorkController, capabilities: Capabilities, artifacts: Artifacts) {
    this.controller = controller
    this.capabilities = capabilities
    this.artifacts = artifacts
  }

  /**
   * Store a `task@1` input; with a repository, first snapshot `ref` there as a
   * `git-tree@1` Artifact the task starts from.
   */
  async newTask(instructions: string, repository: string | undefined, ref: string | undefined, caller: Caller): Promise<{ task: string; base?: string }> {
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
      ...TASK_KIND, content: { instructions, ...(base ? { base } : {}) }, inputs: base ? [base] : [],
      classification: 'local-private', producer,
    })
    return { task: task.id, base }
  }

  /** Read, preflight and pin a Workflow file; the file is never read again for this Work. */
  admitFile(path: string, input: string | undefined, caller: Caller): Promise<WorkRecord> {
    const absolute = resolvePath(path)
    const bytes = readFileSync(absolute)
    const spec = resolve(parseWorkflow(bytes.toString('utf8')), this.capabilities.available())
    return this.controller.admit({ spec, input, caller, source: { kind: 'workflow-file', path: absolute, fileHash: sha256(bytes) } })
  }

  /** A single Task: no Workflow file, one implicit step. */
  admitTask(capabilities: string[], input: string | undefined, caller: Caller): Promise<WorkRecord> {
    const spec = directTask(capabilities, input !== undefined, this.capabilities.available())
    return this.controller.admit({ spec, input, caller, source: { kind: 'direct-task' } })
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
    async putVerdict(verdict) {
      return (await artifacts.put({
        ...VERDICT_KIND, content: verdict, inputs: [verdict.subject, verdict.criteria, ...verdict.evidence],
        subject: { type: 'artifact', ref: verdict.subject },
        classification: 'operator-shared', producer: { type: 'verifier', ref: verdict.verifier.ref },
      })).id
    },
  }
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
  const capabilities = new Capabilities()
  const control = new FileControl(systemPath(ctx, 'control'))
  const controller = new WorkController(domain.table('work') as unknown as WorkTable, specStore(artifacts), capabilities, control)
  ctx.provide('capabilities', capabilities)
  ctx.provide('work', new WorkService(controller, capabilities, artifacts))
}
