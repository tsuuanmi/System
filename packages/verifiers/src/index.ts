/**
 * The `verifiers` row: registers `code.required-checks` and
 * `research.citation-check` and the Artifact kinds of their criteria and
 * evidence (ADR-0003 decisions 6-8, ADR-0004 decisions 12-13).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { subprocessSpawner } from '@system/agents'
import type { Artifacts } from '@system/artifacts'
import type { Capabilities } from '@system/work'
import { CHECKS_KIND, CHECK_RUN_KIND, checkRunSchema, checksSchema, requiredChecks } from './checks.ts'
import { CITATION_CHECK_KIND, CITATION_CRITERIA_KIND, citationCheck, citationCheckSchema, citationCriteriaSchema } from './citations.ts'

export * from './checks.ts'
export * from './citations.ts'

export const name = 'system-verifiers'
export const inject = ['capabilities', 'artifacts', 'subprocess']

export function apply(ctx: Context): void {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  artifacts.registerKind({ ...CHECKS_KIND, content: checksSchema })
  artifacts.registerKind({ ...CHECK_RUN_KIND, content: checkRunSchema })
  artifacts.registerKind({ ...CITATION_CRITERIA_KIND, content: citationCriteriaSchema })
  artifacts.registerKind({ ...CITATION_CHECK_KIND, content: citationCheckSchema })
  const dispose = [
    capabilities.registerVerifier(requiredChecks(artifacts, subprocessSpawner(ctx.get('subprocess') as SubprocessRuntime))),
    capabilities.registerVerifier(citationCheck(artifacts)),
  ]
  ctx.effect(() => () => { for (const d of dispose) d() }, 'verifier registrations')
  ctx.provide('verifiers', { refs: ['code.required-checks', 'research.citation-check'] })
}
