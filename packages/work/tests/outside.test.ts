import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outsideCause } from '../src/outside.ts'

test('the real reasons of 2026-11-10/11 classify', () => {
  assert.equal(outsideCause('Your workspace is out of credits'), 'quota')
  assert.equal(outsideCause('the host stopped before the attempt reported'), 'restart')
  assert.equal(outsideCause('merge conflict with dev at 1289f26abcde: README.md'), 'conflict')
  assert.equal(outsideCause('the base fails it too (base abc)'), 'load')
  assert.equal(outsideCause('timed out after 300 s'), 'slow-host')
  assert.equal(outsideCause('retried by the operator'), undefined)
  assert.equal(outsideCause('tests failed: 3 assertions'), undefined)
  assert.equal(outsideCause(''), undefined)
})
