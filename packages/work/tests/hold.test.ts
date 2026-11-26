import assert from 'node:assert/strict'
import { test } from 'node:test'
import { holdDecision } from '../src/hold.ts'

const rec = (state: object) => ({ id: 'work:w1', state: { status: 'held', steps: {}, effects: {}, results: {}, ...state } }) as any
const X = `sha256:${'a'.repeat(64)}`

test('a Work that is not held has no decision', () => {
  assert.equal(holdDecision(rec({ status: 'running' })), undefined)
})

test('a held merge commit states the step, reason, commit and the three commands', () => {
  const text = holdDecision(rec({ awaiting: 'ship', reason: 'ship: merge commit x awaits operator approval: gate', steps: { ship: { outputs: {} } }, effects: { op: { stepId: 'ship', state: 'absent', held: X } } }))!
  assert.match(text, /step:   ship/)
  assert.match(text, /reason: ship: merge commit x awaits/)
  assert.ok(text.includes(`commit: ${X}`))
  assert.match(text, /system approve work:w1\n/)
  assert.match(text, /system deny work:w1 --reason <why>/)
  assert.match(text, /system work retry work:w1 --step ship/)
})

test('an inconclusive verdict names its subject', () => {
  const text = holdDecision(rec({ awaiting: 'verify', reason: 'inconclusive', steps: { verify: { outputs: {}, verdict: 'inconclusive', subject: X } } }))!
  assert.ok(text.includes(`subject: ${X} (verdict inconclusive)`))
  assert.match(text, /system approve work:w1/)
})

test('an Outside-failure hold offers only a retry', () => {
  const text = holdDecision(rec({ awaiting: 'implement', reason: 'held after 3', steps: { implement: { outputs: {}, outside: { count: 3, cause: 'load', reason: 'x' } } } }))!
  assert.doesNotMatch(text, /system approve|system deny/)
  assert.match(text, /system work retry work:w1 --step implement/)
})

test('an unknown effect outcome with no awaiting step offers a retry of its step', () => {
  const text = holdDecision(rec({ reason: 'the outcome of ship is unknown', effects: { op: { stepId: 'ship', state: 'unknown' } } }))!
  assert.doesNotMatch(text, /system approve/)
  assert.match(text, /system work retry work:w1 --step ship/)
})
