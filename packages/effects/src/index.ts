/**
 * The `effects` row: registers System's effect providers (ADR-0004 decision
 * 10). Today one: `git.publish` for GitHub. Its token comes from the DSH
 * credential store; Worker environments never contain it.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Artifacts } from '@system/artifacts'
import { askVerifier, putVerdict, settleVerdict, type Capabilities, type EffectIntent, type VerificationStore } from '@system/work'
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
  const store: VerificationStore = {
    exists: (id) => artifacts.get(id).state === 'stored',
    kindOf: (id) => { const stored = artifacts.get(id); return stored.state === 'stored' ? stored.envelope.kind : undefined },
    putVerdict: (verdict) => putVerdict(artifacts, verdict),
  }
  return async (subject, intent) => {
    const evidence: string[] = []
    const verdicts: string[] = []
    let hold: string | undefined
    for (const { capability, criteria, verifier: pinned } of intent.required ?? []) {
      if (!pinned) return { verdict: 'error', reason: `no verifier is pinned for ${capability} at admission`, evidence, verdicts }
      const verifier = capabilities.verifierFor(pinned.ref)
      if (!verifier || !verifier.capabilities.includes(capability)) return { verdict: 'error', reason: `${pinned.ref}@${pinned.version}, pinned for ${capability} at admission, is not registered`, evidence, verdicts }
      // Deliberate (PLAN DP decision: a merge awaits an Approval): a changed verifier version holds the merge; the controller refuses a step with `error` instead.
      const attemptId = `merge:${intent.operationId}`
      // The same check slots as the checks step (df-14): at most `maxConcurrentChecks` suites run at once, merge re-checks included.
      const asked = await askVerifier(store, { verifier, pin: pinned, onPinMismatch: 'hold', request: { workId: intent.workId, attemptId, stepId: intent.stepId, capability, subject, criteria, event: 'merge_group' }, around: (run) => capabilities.slots.withCheck(verifier, `${attemptId}:${randomUUID()}`, run) })
      if ('refusal' in asked) {
        if (asked.refusal.verdict === 'hold') { hold ??= asked.refusal.reason; continue }
        return { verdict: 'error', reason: asked.refusal.reason, evidence, verdicts }
      }
      const { bound, verdictId } = await settleVerdict(store, { verifier, capability, subject, criteria, result: asked.result })
      evidence.push(...bound.evidence ?? [])
      verdicts.push(verdictId)
      if (bound.verdict === 'inconclusive') hold ??= `inconclusive: ${bound.reason}`
      else if (bound.verdict !== 'pass') return { verdict: bound.verdict, reason: bound.reason, evidence, verdicts }
    }
    if (!intent.required?.length) return { verdict: 'error', reason: 'the effect requires no checks to run on the merge', evidence, verdicts }
    if (hold) return { verdict: 'hold', reason: hold, evidence, verdicts }
    return { verdict: 'pass', reason: `${intent.required.length} required check(s) passed on the merge`, evidence, verdicts }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  // ct-4: the merge queue's batch mode (ct-3) was removed; an operator who set it must not have it silently ignored.
  if ('mergeBatchSize' in config) throw new Error('the effects option mergeBatchSize was removed (ct-4): the merge queue merges one change at a time; delete it from the profile')
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
