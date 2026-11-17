/**
 * The `classifier` row (cls-1): an optional, off-by-default row that answers closed questions (`classifiers/*.yaml`)
 * about an Artifact with an economy-tier Account, and records each answer as a `classification@1` Artifact.
 * Report-only: `ctx.classifier.failures` feeds `work report`; nothing routes, retries, holds or verifies on it.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { AgentsService } from '@system/agents'
import type { Artifacts } from '@system/artifacts'
import { contentIdSchema, z, type FailureClassifier } from '@system/work'
import { createClassifier } from './classifier.ts'
import { loadQuestions } from './question.ts'

export * from './classifier.ts'
export * from './evidence.ts'
export * from './question.ts'
export * from './schema.ts'
export * from './vote.ts'

export const name = 'system-classifier'
export const inject = ['artifacts', 'storageDomain', 'agents']

/** The question `work report` asks about a failure whose rules answer `unknown`. */
export const FAILURE_CAUSE = 'failure-cause'

/** `classifiers/` of the repository this code is in (from `packages/classifier/{src,lib}`). */
export const DEFAULT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'classifiers')

export interface Config {
  /** The directory of question files; default `classifiers/` beside the Host's own code. */
  directory?: string
}

/** What the row provides as `ctx.classifier`. */
export interface ClassifierService {
  failures: FailureClassifier
}

export const classifierDomain = defineDomain({
  name: 'system_classifier',
  version: 1,
  tables: { classifications: domainTable(z.object({ artifact: contentIdSchema })) },
})

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const artifacts = ctx.get('artifacts') as Artifacts
  const agents = ctx.get('agents') as AgentsService
  const domains = ctx.get('storageDomain') as DomainFacility
  const questions = loadQuestions(config.directory ?? DEFAULT_DIRECTORY)
  const domain = await domains.open(classifierDomain)
  ctx.effect(() => () => { void domain.close() }, 'system_classifier domain')
  const table = domain.table('classifications')
  const classifier = createClassifier({
    artifacts, questions,
    index: { get: (key) => table.get(key), put: (key, value) => table.put(key, value) },
    ask: (prompt, options) => agents.ask(prompt, options),
  })
  ctx.provide('classifier', {
    failures: {
      lookup: classifier.failureLookup(FAILURE_CAUSE),
      // A Classifier that cannot answer never fails the report or the Work.
      classify: (record) => classifier.classifyFailures(FAILURE_CAUSE, record).catch(() => {}),
    },
  } satisfies ClassifierService)
}
