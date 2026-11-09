/**
 * The `effects` row: registers System's effect providers (ADR-0004 decision
 * 10). Today one: `git.publish` for GitHub. Its token comes from the DSH
 * credential store; Worker environments never contain it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Artifacts } from '@system/artifacts'
import type { Capabilities } from '@system/work'
import { githubPublisher, type PublishConfig } from './github.ts'

export * from './github.ts'

export const name = 'system-effects'
export const inject = ['capabilities', 'artifacts', 'credentials']

export interface Config extends Partial<PublishConfig> {
  /** The credential-store name of System's GitHub token. */
  tokenRef?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const capabilities = ctx.get('capabilities') as Capabilities
  const credentials = ctx.get('credentials') as CredentialProvider
  const ref = credentialRef(config.tokenRef ?? 'GITHUB_TOKEN')
  const publisher = githubPublisher(
    ctx.get('artifacts') as Artifacts,
    {
      token: async () => (await credentials.resolve(ref))?.value,
      // The merge queue runs the Work's required checks again, with their pinned criteria, on the merge it made.
      async check(subject, intent) {
        const evidence: string[] = []
        let accepted = false
        for (const { capability, criteria } of intent.required ?? []) {
          const verifier = capabilities.routeVerifier(capability).selected
          if (!verifier) return { verdict: 'error', reason: `no enabled verifier provides ${capability}`, evidence }
          const result = await verifier.verify({ workId: intent.workId, attemptId: `merge:${intent.operationId}`, stepId: intent.stepId, capability, subject, criteria })
          evidence.push(...result.evidence)
          if (result.verdict === 'inconclusive' && intent.acceptedInconclusive) {
            accepted = true
            continue
          }
          if (result.verdict !== 'pass') return { verdict: result.verdict, reason: result.reason, evidence }
        }
        if (!intent.required?.length) return { verdict: 'error', reason: 'the effect requires no checks to run on the merge', evidence }
        return { verdict: 'pass', reason: `${intent.required.length} required check(s) passed on the merge${accepted ? ' (inconclusive, accepted by the operator)' : ''}`, evidence }
      },
    },
    { remote: config.remote ?? 'origin', base: config.base ?? 'main', mergeInto: config.mergeInto ?? [], apiUrl: config.apiUrl ?? 'https://api.github.com', repository: config.repository },
  )
  const dispose = capabilities.registerEffect(publisher)
  ctx.effect(() => dispose, 'effect registrations')
  ctx.provide('effects', { refs: [publisher.ref] })
}
