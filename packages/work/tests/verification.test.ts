/** Verification through its interface: pin, `accepts`, a missing subject, a throw, binding, storage, and the one flaky rule. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askVerifier, bindVerdict, firstRunOf, flakyFirstRuns, isFlakyPass, rerunVerdict, settleVerdict, verifierRerunReason, type AskInput, type VerificationStore } from '../src/verification.ts'
import type { VerifierPort, VerifyRequest, VerifyResult } from '../src/registry.ts'
import type { WorkEvent } from '../src/record.ts'

/** What a caller does: ask, then settle what the verifier said. */
async function verifyUnderPin(store: VerificationStore, input: AskInput & { capability: string; criteria: string }) {
  const asked = await askVerifier(store, input)
  if ('refusal' in asked) return asked
  return settleVerdict(store, { verifier: input.verifier, capability: input.capability, subject: input.request.subject, criteria: input.criteria, result: asked.result })
}

const S = 'sha256:' + 's'.repeat(64)
const C = 'sha256:' + 'c'.repeat(64)
const E = 'sha256:' + 'e'.repeat(64)

function world(opts: { kinds?: Record<string, string>; answer?: (r: VerifyRequest) => VerifyResult | Promise<VerifyResult>; version?: string } = {}) {
  const stored: Parameters<VerificationStore['putVerdict']>[0][] = []
  const asked: VerifyRequest[] = []
  const store: VerificationStore = {
    kindOf: (id) => (opts.kinds ?? { [S]: 'file' })[id],
    exists: (id) => id === E,
    putVerdict: async (v) => { stored.push(v); return `sha256:${'v'.repeat(63)}${stored.length}` },
  }
  const verifier: VerifierPort = {
    ref: 'unit', version: opts.version ?? '1', capabilities: ['unit'], accepts: ['file'], criteria: async () => C,
    async verify(request) {
      asked.push(request)
      return opts.answer ? opts.answer(request) : { verdict: 'pass', reason: 'ok', subject: request.subject, criteria: request.criteria, evidence: [E] }
    },
  }
  const input = (over: Partial<Parameters<typeof verifyUnderPin>[1]> = {}) => ({ verifier, pin: { ref: 'unit', version: '1' }, onPinMismatch: 'error' as const, capability: 'unit', criteria: C, request: { workId: 'w', attemptId: 'a', stepId: 's', capability: 'unit', subject: S, criteria: C }, ...over })
  return { store, verifier, stored, asked, input }
}

test('a pin mismatch is an error for the controller and a hold for the merge check; the verifier is not asked', async () => {
  const w = world({ version: '2' })
  for (const mode of ['error', 'hold'] as const) {
    const out = await verifyUnderPin(w.store, w.input({ onPinMismatch: mode }))
    assert.deepEqual(out, { refusal: { kind: 'pin', verdict: mode, reason: 'pinned unit@1 at admission; unit@2 is enabled now' } })
  }
  assert.equal(w.asked.length, 0)
  assert.equal(w.stored.length, 0)
})

test('a verifier that does not accept the subject kind, or a missing subject, is refused with an error', async () => {
  const w = world({ kinds: { [S]: 'git-tree' } })
  const wrong = await verifyUnderPin(w.store, w.input())
  assert.deepEqual(wrong, { refusal: { kind: 'accepts', verdict: 'error', reason: 'unit judges file, not git-tree' } })
  const missing = await verifyUnderPin(world({ kinds: {} }).store, world({ kinds: {} }).input())
  assert.deepEqual(missing, { refusal: { kind: 'accepts', verdict: 'error', reason: 'unit judges file, not a missing Artifact' } })
  assert.equal(w.asked.length, 0)
})

test('a throw is an error refusal, and nothing is stored', async () => {
  const w = world({ answer: () => { throw new Error('boom') } })
  assert.deepEqual(await verifyUnderPin(w.store, w.input()), { refusal: { kind: 'threw', verdict: 'error', reason: 'the verifier threw: boom' } })
  assert.equal(w.stored.length, 0)
})

test('a verdict is bound to the exact subject, criteria and stored evidence, then stored', async () => {
  const w = world()
  const out = await verifyUnderPin(w.store, w.input())
  assert.ok('verdictId' in out)
  assert.deepEqual(out.bound, { verdict: 'pass', reason: 'ok', evidence: [E] })
  assert.deepEqual(w.stored, [{ subject: S, criteria: C, capability: 'unit', verifier: { ref: 'unit', version: '1' }, verdict: 'pass', reason: 'ok', evidence: [E] }])
  const other = world({ answer: (r) => ({ verdict: 'pass', reason: 'ok', subject: 'sha256:' + 'x'.repeat(64), criteria: r.criteria, evidence: [] }) })
  const refused = await verifyUnderPin(other.store, other.input())
  assert.ok('bound' in refused)
  assert.equal(refused.bound.verdict, 'error')
  assert.match(refused.bound.reason, /^verdict refused: it judged .*; a pass needs evidence \(verifier said pass: ok\)$/)
  assert.equal(other.stored[0]!.verdict, 'error')
})

test('askVerifier passes the verifier its request unchanged', async () => {
  const w = world()
  const asked = await askVerifier(w.store, w.input())
  assert.ok('result' in asked)
  assert.deepEqual(w.asked, [w.input().request])
})

test('bindVerdict refuses unstored evidence', () => {
  const bound = bindVerdict({ verdict: 'pass', reason: 'ok', subject: S, criteria: C, evidence: [E, 'sha256:' + 'n'.repeat(64)] }, S, C, (id) => id === E)
  assert.equal(bound.verdict, 'error')
  assert.deepEqual(bound.evidence, [E])
})

test('flaky: one definition for the controller re-run, the verifier re-run and the summary', async () => {
  const first = { verdictId: 'sha256:' + 'f'.repeat(64), evidence: ['sha256:' + '1'.repeat(64)] }
  const pass = rerunVerdict({ verdict: 'pass', reason: 'ok', evidence: [E] }, first)
  assert.equal(pass.reason, `flaky: failed (${first.verdictId}) then passed on the same change; ok`)
  const fail = rerunVerdict({ verdict: 'fail', reason: 'again', evidence: [E] }, first)
  assert.equal(fail.verdict, 'inconclusive')
  assert.deepEqual(fail.evidence, [...first.evidence, E])
  assert.deepEqual(rerunVerdict({ verdict: 'fail', reason: 'x', evidence: [] }), { verdict: 'fail', reason: 'x', evidence: [] })

  assert.equal(isFlakyPass({ verdict: 'pass', reason: 'ok', rerunOf: first.verdictId }), true)
  assert.equal(isFlakyPass({ verdict: 'pass', reason: `${verifierRerunReason(['unit'], 'unit: red')}all 1 check(s) run passed` }), true)
  assert.equal(isFlakyPass({ verdict: 'pass', reason: 'all 1 check(s) run passed' }), false)
  assert.equal(isFlakyPass({ verdict: 'fail', reason: verifierRerunReason(['unit'], 'x') }), false)

  const events = [
    { type: 'verified', seq: 1, stepId: 's', verdict: 'fail', verdictId: first.verdictId, evidence: first.evidence },
    { type: 'observed', seq: 2, stepId: 'w', unchangedAfter: first.verdictId },
    { type: 'verified', seq: 3, stepId: 's', verdict: 'pass', verdictId: 'sha256:' + '2'.repeat(64), rerunOf: first.verdictId },
  ] as unknown as WorkEvent[]
  assert.deepEqual(firstRunOf(events.slice(0, 2), 's'), first)
  assert.equal(firstRunOf(events.slice(0, 1), 's'), undefined)
  assert.deepEqual([...flakyFirstRuns(events)], [first.verdictId])
})
