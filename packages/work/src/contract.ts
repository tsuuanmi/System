/**
 * What other packages may import from `@system/work` (ADR-0017 decision 1, part 1): the kinds, tiers, ids, schemas, errors and
 * small helpers they share, the types of the registry's ports, and the services' place in `Context`.
 * It imports no plugin entry and opens no service.
 */
// A side-effect import, so the emitted contract.d.ts keeps the module the augmentation below merges into.
import '@deepseek-ai/cordis'
// The service types come by the package's own name (its built entry), so this source and the built contract.d.ts name the same
// declarations: the repository's one typecheck sees both, and two nominal classes (private members) are never the same type.
import type { Capabilities, WorkService } from '@system/work'

export { TASK_KIND, GIT_TREE_KIND } from './kinds.ts'
export { CONVERSATION_KIND } from './conversation.ts'
export { TIERS, requestedTier, tierCapability, writesRepository } from './registry.ts'
export type { WorkerPort, VerifierPort, EffectPort } from './registry.ts'
export { callerSchema, TERMINAL } from './record.ts'
export { ITEM_ID } from './status-parse.ts'
export { WorkError } from './errors.ts'
export { WorkflowError } from './workflow.ts'
export { pin } from './git.ts'
export { dshHome, systemPath } from './home.ts'
export { isSignedOut } from './outside.ts'
export { DEFAULT_QUOTA_CEILING_PERCENT } from './headroom.ts'
export { summarize } from './summary.ts'
export { laterPasses } from './later-pass.ts'
export { defaultChange } from './failure-class.ts'
export { parseStatus } from './status-parse.ts'
export { parseWorkflow, directTask, resolve } from './workflow.ts'
export { holdDecision } from './hold.ts'
export { askVerifier, settleVerdict, putVerdict, verifierRerunReason } from './verification.ts'
export { addConversation } from './conversation.ts'
export { gatedFiles, gatesOf } from './gates.ts'
export { readStatus } from './gate.ts'
export { itemLines, itemOf, readyCount, workStatus, mergeCommitOf, whoHas } from './status.ts'
export { rangeReport } from './measures.ts'
export { releasesBy } from './releases.ts'
export { lateChecks } from './late-checks.ts'
export { activeCoreLines } from './core-lines.ts'
export { roomOf } from './headroom.ts'
export { z } from 'zod'
export { CLASSIFICATIONS, contentIdSchema } from '@system/artifacts/contract'
export type { Capabilities, WorkService }

declare module '@deepseek-ai/cordis' {
  interface Context {
    work: WorkService
    capabilities: Capabilities
  }
}
