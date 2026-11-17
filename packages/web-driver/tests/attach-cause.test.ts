/** The attach failure is marked where it is written: a ProviderError carries `attach`, and the Procedure's result keeps it. No Chrome. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderError } from '../src/index.ts'
import { Procedures } from '../src/procedures.ts'

test('a failed attachText result carries the attach marker; another ui_drift does not', async () => {
  const procedures = (error: Error) => Object.assign(Object.create(Procedures.prototype), {
    map: { actions: { 'composer.attach': {} }, settings: {} },
    engine: { attachText: async () => { throw error } },
  }) as Procedures
  const marked = await procedures(new ProviderError('ui_drift', 'x: attach text failed: reworded', { attach: true })).attachText('b', 'h')
  assert.equal(marked.status, 'failed')
  assert.equal(marked.evidence.attach, true)
  assert.equal(marked.evidence.error, 'ui_drift')
  const plain = await procedures(new ProviderError('ui_drift', 'x: attach text failed')).attachText('b', 'h')
  assert.equal(plain.evidence.attach, undefined)
  assert.equal(new ProviderError('ui_drift', 'm', { attach: true }).attach, true)
  assert.equal('attach' in new ProviderError('ui_drift', 'm'), false)
})
