/**
 * The merge queue's re-check takes the verifier's `check:<ref>` slot like the
 * checks step (df-14): at most `maxConcurrentChecks` suites run at once.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { Capabilities, VERDICT_KIND, verdictSchema, type EffectIntent, type VerifierPort } from '@system/work'
import { mergeCheck } from '../src/index.ts'

async function world(limit: number, behave: (n: number) => Promise<void> = async () => {}) {
  const { artifacts } = memoryArtifacts({ ...VERDICT_KIND, content: verdictSchema })
  const put = async (text: string) => (await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: Buffer.from(text), mediaType: 'text/plain', classification: 'local-private', producer: { type: 'system', ref: 't' } })).id
  const subject = await put('merge commit')
  const criteria = await put('criteria')
  const evidence = await put('log')
  const capabilities = new Capabilities()
  const gauge = { running: 0, peak: 0, started: 0 }
  const verifier: VerifierPort = {
    ref: 'unit-runner', version: '1', capabilities: ['unit'], accepts: ['file'], maxConcurrentChecks: limit,
    criteria: async () => criteria,
    async verify(request) {
      const n = ++gauge.started
      gauge.peak = Math.max(gauge.peak, ++gauge.running)
      try { await behave(n) } finally { gauge.running-- }
      return { verdict: 'pass', reason: 'ok', subject: request.subject, criteria: request.criteria, evidence: [evidence] }
    },
  }
  capabilities.registerVerifier(verifier)
  const intent = (n: number): EffectIntent => ({
    operationId: `op:${n}`, workId: 'work:1', stepId: 'publish', capability: 'git.publish', subject: 'sha256:' + '0'.repeat(64), params: { merge: true },
    required: [{ capability: 'unit', criteria, verifier: { ref: 'unit-runner', version: '1' } }],
  })
  return { capabilities, check: mergeCheck(capabilities, artifacts), subject, intent, gauge, verifier }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

test('two merge re-checks and a checks step together run at most the limit of verify calls at once', async () => {
  const w = await world(2, tick)
  // The checks step (controller) holds its slot while its own verify runs.
  assert.equal(w.capabilities.slots.reserveCheck(w.verifier, 'attempt:step'), true)
  const checks = [w.check(w.subject, w.intent(1)), w.check(w.subject, w.intent(2))]
  await tick()
  assert.equal(w.gauge.running, 1, 'one slot is left for the two re-checks')
  w.capabilities.slots.release('check:unit-runner', 'attempt:step')
  const verdicts = await Promise.all(checks)
  assert.deepEqual(verdicts.map((v) => v.verdict), ['pass', 'pass'])
  assert.ok(w.gauge.peak <= 2, `peak ${w.gauge.peak}`)
})

test('merge re-checks beyond the limit wait, and all of them still pass', async () => {
  const w = await world(2, tick)
  const verdicts = await Promise.all([1, 2, 3, 4].map((n) => w.check(w.subject, w.intent(n))))
  assert.deepEqual(verdicts.map((v) => v.verdict), ['pass', 'pass', 'pass', 'pass'])
  assert.equal(w.gauge.peak, 2)
  assert.equal(w.gauge.started, 4)
})

test('the slot is released when verify throws', async () => {
  const w = await world(1, async (n) => { if (n === 1) throw new Error('boom') })
  const first = await w.check(w.subject, w.intent(1))
  assert.equal(first.verdict, 'error')
  assert.match(first.reason, /the verifier threw: boom/)
  assert.equal(w.capabilities.slots.reserveCheck(w.verifier, 'attempt:next'), true, 'the slot is free again')
  w.capabilities.slots.release('check:unit-runner', 'attempt:next')
  assert.equal((await w.check(w.subject, w.intent(2))).verdict, 'pass')
})
