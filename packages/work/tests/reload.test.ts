/**
 * plug-4 (RES-0021): reloading the `verifiers` plugin through a real Loader while
 * `artifacts` stays up disposes its registered kinds and registers them again
 * without `kind ... is already registered`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Artifacts } from '@system/artifacts'
import { Capabilities } from '../src/registry.ts'
import { memoryBlobStore, memoryRecordTable } from '../../../test-support/memory.ts'

test('reloading the verifiers plugin while artifacts stays up succeeds without duplicate-kind error', async () => {
  const root = new Context()
  const artifacts = new Artifacts(memoryRecordTable(), memoryBlobStore())
  const capabilities = new Capabilities()
  root.provide('artifacts', artifacts)
  root.provide('capabilities', capabilities)
  root.provide('subprocess', {} as never)
  await root.plugin(Loader, { baseUrl: import.meta.url })
  const loader = (root as unknown as {
    loader: {
      create(options: object): Promise<string>
      update(id: string, options: object): Promise<void>
      await(): Promise<void>
      resolve(id: string): { fiber: { await(): Promise<unknown> } }
    }
  }).loader
  const url = pathToFileURL(new URL('../../verifiers/src/index.ts', import.meta.url).pathname).href
  try {
    await loader.create({ id: 'verifiers', name: url, config: {} })
    await loader.await()
    await loader.resolve('verifiers').fiber.await()
    assert.ok(capabilities.available().verifiers.has('code.required-checks'))

    await loader.update('verifiers', { config: { maxConcurrentChecks: 1 } })
    await loader.await()
    await loader.resolve('verifiers').fiber.await()
    assert.ok(capabilities.available().verifiers.has('code.required-checks'))
  } finally {
    await root.fiber.dispose()
  }
})
