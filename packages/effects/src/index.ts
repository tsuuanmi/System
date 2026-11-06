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
    { token: async () => (await credentials.resolve(ref))?.value },
    { remote: config.remote ?? 'origin', base: config.base ?? 'main', mergeInto: config.mergeInto ?? [], apiUrl: config.apiUrl ?? 'https://api.github.com', repository: config.repository },
  )
  const dispose = capabilities.registerEffect(publisher)
  ctx.effect(() => dispose, 'effect registrations')
  ctx.provide('effects', { refs: [publisher.ref] })
}
