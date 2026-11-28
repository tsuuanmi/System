/**
 * What other packages may import from `@system/artifacts` (ADR-0017 decision 1): the Artifact ID helpers, the envelope's
 * schemas and types, the service's type and its place in `Context`. It imports no plugin entry and opens no service.
 */
// A side-effect import, so the emitted contract.d.ts keeps the module the augmentation below merges into (consumers lose `Context.get` without it).
import '@deepseek-ai/cordis'
import type { Artifacts } from './artifacts.ts'

export { canonicalJson, CONTENT_ID_RE, hashDomain, type ContentId } from './canonical.ts'
export { CLASSIFICATIONS, contentIdSchema, type ArtifactRecord, type Classification, type Envelope, type Producer } from './envelope.ts'
export type { Artifacts, ReadResult } from './artifacts.ts'

/**
 * The service's public surface. A class with private members is nominal, and the repository's one typecheck sees both this
 * package's source and its built `lib`; two declarations of `Context.artifacts` must have the same type, so this one is structural.
 */
export type ArtifactsService = Pick<Artifacts, keyof Artifacts>

declare module '@deepseek-ai/cordis' {
  interface Context {
    artifacts: ArtifactsService
  }
}
