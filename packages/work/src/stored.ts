/** Readers shared by the operator records (`intent@1`, `escaped-defect@1`, `confirmation@1`). */
import type { Artifacts } from '@system/artifacts/contract'
import { WorkError } from './errors.ts'

/** Every stored Artifact of `kind`, with its ID and creation time. */
export function storedOf<T>(artifacts: Artifacts, kind: string): { id: string; createdAt: string; content: T }[] {
  const found: { id: string; createdAt: string; content: T }[] = []
  for (const id of artifacts.idsByPrefix(kind, '')) {
    const read = artifacts.get(id)
    if (read.state === 'stored') found.push({ id, createdAt: read.envelope.createdAt, content: read.envelope.content as T })
  }
  return found
}

/** `id` must be a stored Artifact of `kind`@1; `what` names its role in the message. */
export function requireStored(artifacts: Artifacts, id: string, kind: { kind: string; schemaVersion: number }, what: string): void {
  const read = artifacts.get(id)
  if (read.state !== 'stored') throw new WorkError(`${what} ${id} is not a stored Artifact`)
  if (read.envelope.kind !== kind.kind || read.envelope.schemaVersion !== kind.schemaVersion) throw new WorkError(`${what} ${id} is not an ${kind.kind}@${kind.schemaVersion} Artifact`)
}
