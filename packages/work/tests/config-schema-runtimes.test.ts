/**
 * plug-13 (ADR-0017 decision 4): `agents`, `web-worker` and `system-app` export `Config` as a Cordis schema, so the Loader validates
 * a row's config at activation and refuses a wrongly typed field, naming it. The shipped patch's accounts still validate.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { parse } from 'yaml'

/** Row ids stay `agents` and `web-worker` (ADR-0018 decision 4); their packages are `runtime-cli` and `runtime-web`. */
const DIRS: Record<string, string> = { agents: 'runtime-cli', 'web-worker': 'runtime-web' }
const SERVICES = ['storageDomain', 'attachments', 'artifacts', 'capabilities', 'credentials', 'subprocess']

/** Activates one row through a real Loader, the services it injects standing as empty objects; resolves with the fiber's startup error. */
async function activate(id: string, config: unknown): Promise<unknown> {
  const root = new Context()
  for (const service of SERVICES) root.provide(service as never, {} as never)
  await root.plugin(Loader, { baseUrl: import.meta.url })
  const loader = (root as unknown as { loader: { create(options: object): Promise<string>; await(): Promise<void>; resolve(id: string): { fiber: { await(): Promise<unknown> } } } }).loader
  await loader.create({ id, name: pathToFileURL(new URL(`../../${DIRS[id] ?? id}/src/index.ts`, import.meta.url).pathname).href, config })
  await loader.await()
  try { await loader.resolve(id).fiber.await(); return undefined } catch (error) { return error } finally { await root.fiber.dispose() }
}

const account = { ref: 'claude-code/default', runtime: 'claude-code', capabilities: ['research'] }
const wrong: { id: string; config: unknown; message: RegExp }[] = [
  { id: 'agents', config: 'oops', message: /expected object but got oops/ },
  { id: 'agents', config: { accounts: [{ ...account, maxConcurrentAttempts: 'two' }] }, message: /maxConcurrentAttempts expected number but got two/ },
  { id: 'agents', config: { accounts: [{ ...account, capabilities: 'research' }] }, message: /capabilities/ },
  { id: 'agents', config: { accounts: [{ ref: 'a', runtime: 'codex' }] }, message: /capabilities/ },
  { id: 'agents', config: { accounts: [{ ...account, models: { economy: 1 } }] }, message: /models/ },
  { id: 'agents', config: { attemptTimeoutMinutes: 'soon' }, message: /attemptTimeoutMinutes expected number but got soon/ },
  { id: 'agents', config: { quotaCeilingPercent: '80' }, message: /quotaCeilingPercent expected number but got 80/ },
  { id: 'agents', config: { webWorkerWaitSeconds: 'x' }, message: /webWorkerWaitSeconds/ },
  { id: 'web-worker', config: { registerWaitSeconds: 'x' }, message: /registerWaitSeconds expected number but got x/ },
]

for (const { id, config, message } of wrong) {
  test(`the Loader refuses a ${id} row with ${JSON.stringify(config)} at activation, naming the field`, async () => {
    const error = await activate(id, config)
    assert.ok(error instanceof Error, 'activation must fail')
    assert.equal(error.name, 'ValidationError', String(error))
    assert.match(error.message, message)
  })
}

test('the shipped patch accounts and the defaults of today validate', async () => {
  const agents = await import('../../runtime-cli/src/index.ts')
  const web = await import('../../runtime-web/src/index.ts')
  const app = await import('../../app/src/index.ts')
  const check = (schema: unknown, value: unknown) => (schema as { (value: unknown): any })(value)
  const patch = parse(readFileSync(new URL('../../bundle/cordis.patch.yml', import.meta.url), 'utf8')) as { insert: { id: string; config?: unknown }[] }[]
  const row = patch.flatMap((entry) => entry.insert ?? []).find((entry) => entry.id === 'agents')!
  const config = check(agents.Config, row.config)
  assert.equal(config.accounts.length, 2)
  assert.equal(config.accounts[0].models.frontier, 'opus')
  assert.equal(config.attemptTimeoutMinutes, 60)
  assert.deepEqual(check(agents.Config, undefined).accounts, [])
  assert.equal(check(agents.Config, undefined).webWorkerWaitSeconds, 30)
  assert.equal(check(web.Config, undefined).registerWaitSeconds, 60)
  assert.deepEqual(check(app.Config, undefined), {})
})

test('an unset list, map or budget stays unset: the schema adds no [] or {} that apply would read as a value', async () => {
  const agents = await import('../../runtime-cli/src/index.ts')
  const config = (agents.Config as unknown as { (value: unknown): any })({ accounts: [{ ref: 'web/chatgpt/default', runtime: 'web', capabilities: ['research'] }] })
  const account = config.accounts[0]
  for (const field of ['cooldownSeconds', 'models', 'timeouts', 'attemptBudget']) assert.equal(account[field], undefined, field)
  assert.equal(config.attemptBudget, undefined)
  assert.equal(config.quota, undefined)
})
