/**
 * The `verifiers` row: registers `code.required-checks`, `release.install-check` and
 * `research.citation-check` and the Artifact kinds of their criteria and
 * evidence (ADR-0003 decisions 6-8, ADR-0004 decisions 12-13).
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { subprocessSpawner } from '@system/agents/contract'
import type { Artifacts } from '@system/artifacts/contract'
import type { Capabilities } from '@system/work/contract'
import { CHECKS_KIND, CHECK_RUN_KIND, checkRunSchema, checksSchema, requiredChecks } from './checks.ts'
import { installCheck } from './install-check.ts'
import { CITATION_CHECK_KIND, CITATION_CRITERIA_KIND, citationCheck, citationCheckSchema, citationCriteriaSchema } from './citations.ts'

export * from './checks.ts'
export * from './citations.ts'
export * from './draft-checks.ts'
export * from './install-check.ts'

export const name = 'system-verifiers'
export const inject = ['capabilities', 'artifacts', 'subprocess']

export const DEFAULT_MAX_CONCURRENT_CHECKS = 2

export interface Config {
  /** Variables (names `[A-Z_][A-Z0-9_]*`, not HOME, PATH or CI) given to every `code.required-checks` check, e.g. RUSTUP_HOME. */
  checkEnv?: Record<string, string>
  /** How many `code.required-checks` runs go at once on the machine; the others wait for a check slot. Default 2. */
  maxConcurrentChecks: number
}
export const Config: Schema<Config> = Schema.object({
  checkEnv: Schema.dict(Schema.string()),
  maxConcurrentChecks: Schema.number().min(1).step(1).default(DEFAULT_MAX_CONCURRENT_CHECKS),
})

export function apply(ctx: Context, config: Config): void {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  const dispose = [
    artifacts.registerKind({ ...CHECKS_KIND, content: checksSchema }),
    artifacts.registerKind({ ...CHECK_RUN_KIND, content: checkRunSchema }),
    artifacts.registerKind({ ...CITATION_CRITERIA_KIND, content: citationCriteriaSchema }),
    artifacts.registerKind({ ...CITATION_CHECK_KIND, content: citationCheckSchema }),
    capabilities.registerVerifier(requiredChecks(artifacts, subprocessSpawner(ctx.get('subprocess') as SubprocessRuntime), Date.now, config.checkEnv, config.maxConcurrentChecks)),
    capabilities.registerVerifier(installCheck(artifacts, subprocessSpawner(ctx.get('subprocess') as SubprocessRuntime))),
    capabilities.registerVerifier(citationCheck(artifacts)),
  ]
  ctx.effect(() => () => { for (const d of dispose) d() }, 'verifier registrations')
  ctx.provide('verifiers', { refs: ['code.required-checks', 'release.install-check', 'research.citation-check'] })
}
