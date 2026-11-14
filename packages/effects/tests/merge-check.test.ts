/**
 * The merge queue's re-check on a merge commit, through the real `mergeCheck`
 * (the one `apply` hands the publisher) with a real Capabilities registry and
 * Artifact store: a verification like any other (cm-3).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { Capabilities, VERDICT_KIND, verdictSchema, type EffectIntent, type VerifierPort, type VerifyRequest, type VerifyResult } from '@system/work'
import { mergeCheck } from '../src/index.ts'

async function world(version = '1') {
  const { artifacts } = memoryArtifacts({ ...VERDICT_KIND, content: verdictSchema })
  const put = async (text: string) => (await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: Buffer.from(text), mediaType: 'text/plain', classification: 'local-private', producer: { type: 'system', ref: 't' } })).id
  const subject = await put('merge commit')
  const criteria = await put('criteria')
  const evidence = await put('log')
  const capabilities = new Capabilities()
  const asked: VerifyRequest[] = []
  let answer: (request: VerifyRequest) => Partial<VerifyResult> = () => ({})
  const verifier: VerifierPort = {
    ref: 'unit-runner', version, capabilities: ['unit'], accepts: [],
    criteria: async () => criteria,
    async verify(request) {
      asked.push(request)
      return { verdict: 'pass', reason: 'ok', subject: request.subject, criteria: request.criteria, evidence: [evidence], ...answer(request) }
    },
  }
  capabilities.registerVerifier(verifier)
  const intent: EffectIntent = {
    operationId: 'op:1', workId: 'work:1', stepId: 'publish', capability: 'git.publish', subject: 'sha256:' + '0'.repeat(64), params: { merge: true },
    required: [{ capability: 'unit', criteria, verifier: { ref: 'unit-runner', version: '1' } }],
  }
  return { artifacts, check: mergeCheck(capabilities, artifacts), subject, criteria, evidence, intent, asked, answer: (f: typeof answer) => { answer = f }, capabilities }
}

test('a pass with no evidence is refused, and so is a pass whose evidence is not stored', async () => {
  const w = await world()
  w.answer(() => ({ evidence: [] }))
  const none = await w.check(w.subject, w.intent)
  assert.equal(none.verdict, 'error')
  assert.match(none.reason, /a pass needs evidence/)
  w.answer(() => ({ evidence: ['sha256:' + 'f'.repeat(64)] }))
  const missing = await w.check(w.subject, w.intent)
  assert.equal(missing.verdict, 'error')
  assert.match(missing.reason, /is not stored/)
})

test('a verdict about another subject or with other criteria is refused', async () => {
  const w = await world()
  w.answer(() => ({ subject: w.evidence }))
  const subject = await w.check(w.subject, w.intent)
  assert.equal(subject.verdict, 'error')
  assert.match(subject.reason, /it judged .*, not the subject/)
  w.answer(() => ({ criteria: w.evidence }))
  const criteria = await w.check(w.subject, w.intent)
  assert.equal(criteria.verdict, 'error')
  assert.match(criteria.reason, /not the pinned/)
})

test('a verifier version that changed since admission holds the merge and runs nothing; one no longer registered is refused', async () => {
  const w = await world('2')
  const held = await w.check(w.subject, w.intent)
  assert.equal(held.verdict, 'hold')
  assert.match(held.reason, /pinned unit-runner@1 at admission; unit-runner@2 is enabled now/)
  assert.equal(w.asked.length, 0)
  const gone = await w.check(w.subject, { ...w.intent, required: [{ ...w.intent.required![0]!, verifier: { ref: 'other', version: '1' } }] })
  assert.equal(gone.verdict, 'error')
  assert.match(gone.reason, /other@1.*not registered/)
})

test('an inconclusive verdict on the merge commit holds, even when an earlier inconclusive verdict was approved', async () => {
  const w = await world()
  w.answer(() => ({ verdict: 'inconclusive', reason: 'flaky' }))
  const held = await w.check(w.subject, { ...w.intent, approvedMerge: 'sha256:' + 'a'.repeat(64) })
  assert.equal(held.verdict, 'hold')
  assert.match(held.reason, /inconclusive: flaky/)
  assert.equal(held.verdicts?.length, 1)
})

test('a correct pass passes with the criteria pinned at admission, and its verdict Artifact is stored and bound', async () => {
  const w = await world()
  const done = await w.check(w.subject, w.intent)
  assert.equal(done.verdict, 'pass')
  assert.equal(w.asked[0]!.criteria, w.criteria)
  assert.equal(w.asked[0]!.subject, w.subject)
  assert.deepEqual(done.evidence, [w.evidence])
  assert.equal(done.verdicts?.length, 1)
  const read = w.artifacts.get(done.verdicts![0]!)
  assert.ok(read.state === 'stored')
  assert.deepEqual(read.envelope.content, { subject: w.subject, criteria: w.criteria, capability: 'unit', verifier: { ref: 'unit-runner', version: '1' }, verdict: 'pass', reason: 'ok', evidence: [w.evidence] })
})
