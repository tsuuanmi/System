/** sc-4: what the row gives routing: each Worker's priority, quota reading and the configured ceiling. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeCodexHome, tempDir } from '../../../test-support/accounts.ts'
import { apply } from '../src/index.ts'

async function mount(config: object, accounts: object[]) {
  const ports: any[] = []
  const provided: Record<string, any> = {}
  const services = {
    capabilities: { registerWorker: (w: unknown) => { ports.push(w); return () => {} } },
    artifacts: {}, credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'T' }) },
    subprocess: { resolveExecutable: async (c: string) => c, spawn: () => ({ done: Promise.resolve({}), collected: {} }) },
  } as Record<string, unknown>
  const ctx = { get: (key: string) => services[key], effect: () => {}, provide: (key: string, value: unknown) => { provided[key] = value }, baseDir: tempDir('base-') }
  await apply(ctx as never, { ...config, accounts } as never)
  return { ports, accounts: await provided.agents.accounts() as any[] }
}
const codex = (ref: string, own: object = {}) => ({ ref, runtime: 'codex', capabilities: ['code-write'], codexHome: fakeCodexHome(undefined, ref), ...own })

test('a Worker offers its priority, the configured ceiling and its quota reading to routing', async () => {
  const { ports } = await mount({ quotaCeilingPercent: 70 }, [codex('codex/a', { priority: 'primary' }), codex('codex/b')])
  assert.deepEqual(ports.map((p) => [p.ref, p.priority, p.quotaCeilingPercent]), [['codex/a', 'primary', 70], ['codex/b', 'secondary', 70]])
  assert.equal(typeof (await ports[0].quota()).unreadable, 'string', 'a reader that cannot answer is unreadable, not a throw')
})

test('a ceiling outside 1-100 refuses the accounts, naming the value', async () => {
  for (const bad of [0, 101, 'high']) {
    const { ports, accounts } = await mount({ quotaCeilingPercent: bad }, [codex('codex/a')])
    assert.equal(ports.length, 0)
    assert.match(accounts[0].reason, new RegExp(`quotaCeilingPercent is ${bad}; it must be a number from 1 to 100`))
  }
})
