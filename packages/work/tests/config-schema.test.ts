/**
 * plug-12 (ADR-0017 decision 4): `artifacts`, `work`, `effects` and `verifiers` export `Config` as a Cordis schema, so the Loader
 * validates a row's config at activation and refuses a wrongly typed field, naming it. A valid (or empty) config still activates.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const SERVICES = ['storageDomain', 'attachments', 'artifacts', 'capabilities', 'credentials', 'subprocess']

/** Activates one row through a real Loader, the services it injects standing as empty objects; resolves with the fiber's startup error. */
async function activate(id: string, config: unknown): Promise<unknown> {
  const root = new Context()
  for (const service of SERVICES) root.provide(service as never, {} as never)
  await root.plugin(Loader, { baseUrl: import.meta.url })
  const loader = (root as unknown as { loader: { create(options: object): Promise<string>; await(): Promise<void>; resolve(id: string): { fiber: { await(): Promise<unknown> } } } }).loader
  await loader.create({ id, name: pathToFileURL(new URL(`../../${id}/src/index.ts`, import.meta.url).pathname).href, config })
  await loader.await()
  try { await loader.resolve(id).fiber.await(); return undefined } catch (error) { return error } finally { await root.fiber.dispose() }
}

const wrong: { id: string; config: unknown; message: RegExp }[] = [
  { id: 'artifacts', config: 'oops', message: /expected object but got oops/ },
  { id: 'work', config: { stallMinutes: 'ten' }, message: /stallMinutes expected number but got ten/ },
  { id: 'effects', config: { tokenRef: 7 }, message: /tokenRef expected string but got 7/ },
  { id: 'effects', config: { mergeInto: 'dev' }, message: /mergeInto/ },
  { id: 'verifiers', config: { maxConcurrentChecks: 'two' }, message: /maxConcurrentChecks expected number but got two/ },
  { id: 'verifiers', config: { maxConcurrentChecks: 0 }, message: /maxConcurrentChecks expected number >= 1 but got 0/ },
  { id: 'verifiers', config: { maxConcurrentChecks: 1.5 }, message: /maxConcurrentChecks/ },
  { id: 'verifiers', config: { checkEnv: { A: 1 } }, message: /checkEnv/ },
]

for (const { id, config, message } of wrong) {
  test(`the Loader refuses a ${id} row with ${JSON.stringify(config)} at activation, naming the field`, async () => {
    const error = await activate(id, config)
    assert.ok(error instanceof Error, 'activation must fail')
    assert.equal(error.name, 'ValidationError', String(error))
    assert.match(error.message, message)
  })
}

test('the defaults of today are the schema defaults', () => {
  const parse = (schema: unknown, value: unknown) => (schema as { (value: unknown): unknown })(value)
  return import('../src/index.ts').then(async (work) => {
    const effects = await import('../../effects/src/index.ts')
    const verifiers = await import('../../verifiers/src/index.ts')
    assert.deepEqual(parse(work.Config, undefined), { stallMinutes: 10 })
    assert.deepEqual(parse(effects.Config, undefined), { remote: 'origin', base: 'main', mergeInto: [], apiUrl: 'https://api.github.com', tokenRef: 'GITHUB_TOKEN' })
    assert.equal((parse(verifiers.Config, undefined) as { maxConcurrentChecks: number }).maxConcurrentChecks, 2)
  })
})
