/**
 * The `artifacts` row: provides `ctx.artifacts` over the DSH storage domain
 * `system_artifacts` (one key per Artifact ID) and the DSH attachment store.
 */
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { Artifacts, type BlobStore, type RecordTable } from './artifacts.ts'
import { recordSchema } from './envelope.ts'

export * from './artifacts.ts'
export * from './canonical.ts'
export * from './envelope.ts'

export const name = 'system-artifacts'
export const inject = ['storageDomain', 'attachments']

export const artifactsDomain = defineDomain({
  name: 'system_artifacts',
  version: 1,
  tables: { artifacts: domainTable(recordSchema) },
})

/** Every Artifact blob is stored under this display name, so one bytes object has one alias. */
const BLOB_NAME = 'artifact'

function blobStore(attachments: AttachmentStore): BlobStore {
  const ref = (attachmentId: string, bytes: number) => ({ attachmentId, name: BLOB_NAME, bytes }) as unknown as FileAttachmentRef
  return {
    async save(data) {
      const saved = await attachments.saveFile({ data, name: BLOB_NAME })
      return { attachmentId: saved.attachmentId as string, bytes: saved.bytes }
    },
    async read({ attachmentId, bytes }) {
      const path = attachments.fileHostPath(ref(attachmentId, bytes))
      if (path !== undefined && !existsSync(path)) return undefined
      const chunks: Uint8Array[] = []
      // The store verifies the digest while reading; a corrupt object rejects here.
      for await (const chunk of attachments.readFileStream(ref(attachmentId, bytes))) chunks.push(chunk)
      return Buffer.concat(chunks)
    },
  }
}

export async function apply(ctx: Context): Promise<void> {
  const domains = ctx.get('storageDomain') as DomainFacility
  const domain = await domains.open(artifactsDomain)
  ctx.effect(() => () => { void domain.close() }, 'system_artifacts domain')
  const records = domain.table('artifacts') as unknown as RecordTable
  ctx.provide('artifacts', new Artifacts(records, blobStore(ctx.get('attachments') as AttachmentStore)))
}
