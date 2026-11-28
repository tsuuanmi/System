import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const fromRoot = createRequire(new URL('../../../package.json', import.meta.url))
const fromWork = createRequire(fromRoot.resolve('@system/work/package.json'))
const { parse } = fromWork('yaml') as { parse(text: string): unknown }
interface Entry { id?: string; config?: { accounts?: { ref: string; capabilities?: string[] }[] } }
const bundle = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as { insert: Entry[] }[]
const row = (id: string) => bundle[0]!.insert.find((entry) => entry.id === id)!

test('the shipped Accounts have the develop.implement Role, and grant no ability or old name', () => {
  const accounts = row('runtime-cli').config!.accounts!
  const claude = accounts.find((account) => account.ref === 'claude-code/default')!
  const codex = accounts.find((account) => account.ref === 'codex/default')!
  assert.ok(claude.capabilities!.includes('develop.implement'))
  assert.ok(!codex.capabilities!.includes('develop.implement'))
  assert.equal(bundle[0]!.insert.find((entry) => entry.id === 'fakes'), undefined)
  for (const account of accounts) for (const old of ['code-write', 'code.develop', 'web-search', 'research.web']) assert.ok(!account.capabilities!.includes(old), `${account.ref} ${old}`)
})
