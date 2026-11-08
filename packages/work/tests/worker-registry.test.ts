import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capabilities, type WorkerPort } from '../src/registry.ts'

const worker = (ref: string, capabilities: string[]): WorkerPort => ({
  ref, capabilities,
  async run() { return { status: 'failed', outputs: {} } },
})

test('routing uses capabilities rather than provider, and optional Worker unregister is idempotent', () => {
  const registry = new Capabilities()
  const removeHeadless = registry.registerWorker(worker('headless/account', ['code-write']))
  const removeAcp = registry.registerWorker(worker('acp/account', ['code-write', 'research']))
  assert.equal(registry.routeWorker(['research']).selected?.ref, 'acp/account')
  assert.equal(registry.routeWorker(['code-write'], 'acp/account').selected?.ref, 'acp/account')
  removeAcp()
  removeAcp()
  assert.deepEqual(registry.workerRefs(), ['headless/account'])
  assert.equal(registry.routeWorker(['code-write']).selected?.ref, 'headless/account')
  removeHeadless()
  assert.deepEqual(registry.workerRefs(), [])
})

test('different plugin registrations cannot claim the same Worker ref', () => {
  const registry = new Capabilities()
  const first = registry.registerWorker(worker('shared/account', ['research']))
  assert.throws(() => registry.registerWorker(worker('shared/account', ['code-write'])), /already registered/)
  assert.deepEqual(registry.workerRefs(), ['shared/account'])
  first()
  assert.equal(registry.registerWorker(worker('shared/account', ['code-write'])) instanceof Function, true)
})
