import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capabilities, type WorkerPort } from '../src/registry.ts'
import { directTask } from '../src/workflow.ts'

const worker = (ref: string, capabilities: string[]): WorkerPort => ({ ref, capabilities, run: async () => ({ status: 'succeeded', outputs: {} }) })
// The Accounts as the `agents` row builds them: the Runtime's abilities, plus what the profile grants.
const web = worker('web/fake', ['web.search', 'web.browse', 'research', 'tier.standard'])
const claude = worker('claude-code/fake', ['repo.read', 'repo.write', 'web.search', 'develop.implement', 'research', 'tier.standard'])
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

test('a Claude Code Account takes a step needing repo.write or develop.implement', () => {
  const capabilities = registry(web, claude)
  for (const need of ['repo.write', 'develop.implement', 'repo.read']) assert.equal(routed(capabilities, [need]), claude.ref, need)
})

test('the web Runtime abilities web.search and web.browse route', () => {
  const capabilities = registry(claude, web)
  assert.equal(routed(capabilities, ['web.browse']), web.ref)
  assert.equal(routed(capabilities, ['web.search']), claude.ref)
})

test('an old name is an unknown capability: no Account serves it, even one granted the new name', () => {
  const capabilities = registry(web, claude)
  for (const old of ['code-write', 'web-search', 'research.web', 'code.develop']) assert.equal(routed(capabilities, [old]), undefined, old)
  assert.match(capabilities.routeWorker(['code-write']).candidates[1]!.reason, /lacks code-write/)
})

test('an Account granted only old names serves no new name', () => {
  const old = worker('codex/old', ['code-write', 'web-search', 'research.web', 'code.develop'])
  const capabilities = registry(old)
  for (const need of ['repo.write', 'web.search', 'web.browse', 'develop.implement']) assert.equal(routed(capabilities, [need]), undefined, need)
})

test('a profile granting code.develop no longer routes develop.implement', () => {
  const capabilities = registry(worker('claude-code/fake', ['repo.read', 'repo.write', 'code.develop', 'tier.standard']))
  assert.equal(routed(capabilities, ['repo.write', 'develop.implement', 'tier.standard']), undefined)
})

test('preflight offers the new names only', () => {
  const { workers } = registry(claude, web).available()
  for (const name of ['repo.write', 'develop.implement', 'web.browse']) assert.ok(workers.has(name), name)
  for (const name of ['code-write', 'code.develop', 'research.web', 'web-search']) assert.ok(!workers.has(name), name)
  assert.ok(!registry(web).available().workers.has('repo.read'))
})

test('a step needing code-write is refused at admission: no enabled Worker provides it', () => {
  const capabilities = registry(web, claude)
  assert.throws(() => directTask(['code-write', 'tier.standard'], false, capabilities.available()), /needs Worker capability code-write, which no enabled Worker provides/)
  assert.doesNotThrow(() => directTask(['repo.write', 'tier.standard'], false, capabilities.available()))
  assert.equal(capabilities.rankable(['code-write']).length, 0)
})

test('prefer does not match an old name', () => {
  const capabilities = registry(claude, web)
  const route = capabilities.routeWorker(['research'], undefined, undefined, undefined, undefined, undefined, 'research.web')
  assert.notEqual(route.selected?.ref, web.ref)
})
