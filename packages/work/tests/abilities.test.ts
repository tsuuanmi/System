import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capabilities, hasCapability, type WorkerPort } from '../src/registry.ts'
import { directTask } from '../src/workflow.ts'

const worker = (ref: string, capabilities: string[]): WorkerPort => ({ ref, capabilities, run: async () => ({ status: 'succeeded', outputs: {} }) })
// The Accounts as the `agents` row builds them: the Runtime's abilities, plus what the profile grants.
const web = worker('web/fake', ['web.search', 'web.browse', 'research', 'tier.standard'])
const claude = worker('claude-code/fake', ['repo.read', 'repo.write', 'web.search', 'code.develop', 'research', 'tier.standard'])
const registry = (...ports: WorkerPort[]) => {
  const capabilities = new Capabilities()
  for (const port of ports) capabilities.registerWorker(port)
  return capabilities
}
const routed = (capabilities: Capabilities, needs: string[]) => capabilities.routeWorker(needs).selected?.ref

test('a web Account cannot take a step needing repo.read', () => {
  const route = registry(web).routeWorker(['repo.read'])
  assert.equal(route.selected, undefined)
  assert.match(route.candidates[0]!.reason, /lacks repo\.read/)
})

test('a Claude Code Account takes a step needing repo.write, code-write or develop.implement', () => {
  const capabilities = registry(web, claude)
  for (const need of ['repo.write', 'code-write', 'develop.implement', 'repo.read']) assert.equal(routed(capabilities, [need]), claude.ref, need)
})

test('the web Runtime abilities web.search and web.browse route, with their old names', () => {
  const capabilities = registry(claude, web)
  assert.equal(routed(capabilities, ['web.browse']), web.ref)
  assert.equal(routed(capabilities, ['research.web']), web.ref)
  assert.equal(routed(capabilities, ['web-search']), claude.ref)
})

test('an old name an Account is granted serves the new name a step needs', () => {
  const old = worker('codex/old', ['code-write', 'web-search', 'research.web', 'code.develop'])
  const capabilities = registry(old)
  for (const need of ['repo.write', 'web.search', 'web.browse', 'develop.implement', 'code-write', 'code.develop']) assert.equal(routed(capabilities, [need]), old.ref, need)
  assert.equal(routed(capabilities, ['repo.read']), undefined)
})

test('an old pinned spec with code-write routes as before', () => {
  const capabilities = registry(web, claude)
  const spec = directTask(['code-write', 'tier.standard'], false, capabilities.available())
  assert.deepEqual(spec.steps.map((s) => 'capabilities' in s ? s.capabilities : []), [['code-write', 'tier.standard']])
  assert.equal(routed(capabilities, ['code-write', 'tier.standard']), claude.ref)
  assert.equal(capabilities.rankable(['code-write']).length, 1)
})

test('preflight sees the new names through the old and the old through the new', () => {
  const { workers } = registry(claude, web).available()
  for (const name of ['repo.write', 'code-write', 'develop.implement', 'code.develop', 'web.browse', 'research.web', 'web-search']) assert.ok(workers.has(name), name)
  assert.ok(!registry(web).available().workers.has('repo.read'))
})

test('prefer matches through the alias table', () => {
  const capabilities = registry(claude, web)
  assert.equal(capabilities.routeWorker(['research'], undefined, undefined, undefined, undefined, undefined, 'research.web').selected?.ref, web.ref)
})

test('hasCapability is the one match', () => {
  assert.ok(hasCapability(['code-write'], 'repo.write'))
  assert.ok(hasCapability(['repo.write'], 'code-write'))
  assert.ok(!hasCapability(['repo.read'], 'repo.write'))
  assert.ok(!hasCapability(['research'], 'research.web'))
})
