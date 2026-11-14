/**
 * The `effects` row: registers System's effect providers (ADR-0004 decision
 * 10). Today one: `git.publish` for GitHub. Its token comes from the DSH
 * credential store; Worker environments never contain it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Artifacts } from '@system/artifacts'
import { bindVerdict, putVerdict, type Capabilities, type EffectIntent, type VerifyResult } from '@system/work'
import { githubPublisher, type MergeCheck, type PublishConfig } from './github.ts'

export * from './github.ts'

export const name = 'system-effects'
export const inject = ['capabilities', 'artifacts', 'credentials']

export interface Config extends Partial<PublishConfig> {
  /** The credential-store name of System's GitHub token. */
  tokenRef?: string
}

/**
 * The merge queue's re-check on a merge commit, a verification like any other:
 * the verifier and version pinned at admission, the pinned criteria, the
 * controller's binding of subject, criteria and evidence, and a stored verdict
 * Artifact per check. A changed verifier version or an inconclusive verdict
 * holds the merge for an Approval of that commit.
 */
export function mergeCheck(capabilities: Capabilities, artifacts: Artifacts): (subject: string, intent: EffectIntent) => Promise<MergeCheck> {
  const exists = (id: string) => artifacts.get(id).state === 'stored'
  return async (subject, intent) => {
    const evidence: string[] = []
    const verdicts: string[] = []
    let hold: string | undefined
    for (const { capability, criteria, verifier: pinned } of intent.required ?? []) {
      if (!pinned) return { verdict: 'error', reason: `no verifier is pinned for ${capability} at admission`, evidence, verdicts }
      const verifier = capabilities.verifierFor(pinned.ref)
      if (!verifier || !verifier.capabilities.includes(capability)) return { verdict: 'error', reason: `${pinned.ref}@${pinned.version}, pinned for ${capability} at admission, is not registered`, evidence, verdicts }
      if (verifier.version !== pinned.version) {
        hold ??= `pinned ${pinned.ref}@${pinned.version} at admission; ${verifier.ref}@${verifier.version} is enabled now`
        continue
      }
      let result: VerifyResult
      try {
        result = await verifier.verify({ workId: intent.workId, attemptId: `merge:${intent.operationId}`, stepId: intent.stepId, capability, subject, criteria })
      } catch (error) {
        return { verdict: 'error', reason: `the verifier threw: ${(error as Error).message}`, evidence, verdicts }
      }
      const bound = bindVerdict(result, subject, criteria, exists)
      evidence.push(...bound.evidence)
      verdicts.push(await putVerdict(artifacts, { subject, criteria, capability, verifier: { ref: verifier.ref, version: verifier.version }, verdict: bound.verdict, reason: bound.reason, evidence: bound.evidence }))
      if (bound.verdict === 'inconclusive') hold ??= `inconclusive: ${bound.reason}`
      else if (bound.verdict !== 'pass') return { verdict: bound.verdict, reason: bound.reason, evidence, verdicts }
    }
    if (!intent.required?.length) return { verdict: 'error', reason: 'the effect requires no checks to run on the merge', evidence, verdicts }
    if (hold) return { verdict: 'hold', reason: hold, evidence, verdicts }
    return { verdict: 'pass', reason: `${intent.required.length} required check(s) passed on the merge`, evidence, verdicts }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const capabilities = ctx.get('capabilities') as Capabilities
  const credentials = ctx.get('credentials') as CredentialProvider
  const ref = credentialRef(config.tokenRef ?? 'GITHUB_TOKEN')
  const publisher = githubPublisher(
    ctx.get('artifacts') as Artifacts,
    {
      token: async () => (await credentials.resolve(ref))?.value,
      check: mergeCheck(capabilities, ctx.get('artifacts') as Artifacts),
    },
    { remote: config.remote ?? 'origin', base: config.base ?? 'main', mergeInto: config.mergeInto ?? [], apiUrl: config.apiUrl ?? 'https://api.github.com', repository: config.repository },
  )
  const dispose = capabilities.registerEffect(publisher)
  ctx.effect(() => dispose, 'effect registrations')
  ctx.provide('effects', { refs: [publisher.ref] })
}
