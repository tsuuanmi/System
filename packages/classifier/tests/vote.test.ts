import assert from 'node:assert/strict'
import { test } from 'node:test'
import { vote } from '../src/vote.ts'

const LABELS = ['quota', 'restart', 'load', 'unknown']

test('three that agree are the label with confidence 1, and no disagreement', () => {
  assert.deepEqual(vote(['quota', 'quota', 'quota'], LABELS), { label: 'quota', confidence: 1, distribution: { quota: 1 }, disagreement: false })
})

test('two of three are the label with confidence 0.67, and the disagreement is recorded', () => {
  assert.deepEqual(vote(['quota', 'load', 'quota'], LABELS), { label: 'quota', confidence: 0.67, distribution: { quota: 0.67, load: 0.33 }, disagreement: true })
})

test('all three differ: unknown, whatever the shares', () => {
  const out = vote(['quota', 'load', 'restart'], LABELS)
  assert.equal(out.label, 'unknown')
  assert.equal(out.disagreement, true)
  assert.deepEqual(out.distribution, { quota: 0.33, load: 0.33, restart: 0.33 })
})

test('an answer outside the enum is a vote for unknown, never for its own label', () => {
  assert.deepEqual(vote(['quota', 'banana', 'quota'], LABELS), { label: 'quota', confidence: 0.67, distribution: { quota: 0.67, unknown: 0.33 }, disagreement: true })
  assert.equal(vote(['banana', 'banana', 'quota'], LABELS).label, 'unknown')
  assert.equal(vote([undefined, undefined, undefined], LABELS).label, 'unknown')
  assert.equal(vote(['banana', 'pear', 'quota'], LABELS).label, 'unknown')
})

test('a tie, or a winner under two thirds of the samples, is unknown', () => {
  assert.equal(vote(['quota', 'load'], LABELS).label, 'unknown')
  assert.equal(vote(['quota', 'quota', 'load', 'load', 'restart'], LABELS).label, 'unknown')
  assert.equal(vote(['quota', 'quota', 'quota', 'load', 'load'], LABELS).label, 'unknown', '3 of 5 is under two thirds')
  assert.equal(vote(['quota', 'quota', 'quota', 'quota', 'load'], LABELS).label, 'quota')
  assert.equal(vote(['quota'], LABELS).label, 'quota')
})
