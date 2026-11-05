import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalJson, hashDomain, sha256 } from '../src/canonical.ts'

test('object keys are sorted and undefined members omitted', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}')
  assert.equal(canonicalJson({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}')
})

test('sparse array holes serialize as null', () => {
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(canonicalJson([1, , 3]), '[1,null,3]')
})

test('values a hash could not reproduce are refused', () => {
  assert.throws(() => canonicalJson(Number.NaN), TypeError)
  assert.throws(() => canonicalJson(Infinity), TypeError)
  assert.throws(() => canonicalJson(new Date()), TypeError)
  assert.throws(() => canonicalJson(() => 1), TypeError)
  assert.throws(() => canonicalJson(1n), TypeError)
})

test('sha256 is lowercase hex with the sha256: prefix', () => {
  assert.equal(sha256(''), 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('hash domains separate equal values', () => {
  const value = { a: 1 }
  assert.notEqual(hashDomain('system.artifact/v1', value), hashDomain('system.workflow/v1', value))
  assert.notEqual(hashDomain('system.artifact/v1', value), sha256(canonicalJson(value)))
  assert.equal(hashDomain('system.artifact/v1', { a: 1 }), hashDomain('system.artifact/v1', JSON.parse('{"a":1}')))
  assert.throws(() => hashDomain('no version', value), TypeError)
})
