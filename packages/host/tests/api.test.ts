import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTHORITIES, tableOf } from '../src/index.ts'
import { operations, type Services } from '../src/operations.ts'

const table = tableOf(operations({} as Services))

test('every row of the table says what it does', () => {
  for (const [name, method] of Object.entries(table)) assert.ok(method.summary, `${name} has no summary`)
})

test('every row of the table declares its Authority (operator, caller or worker)', () => {
  const valid = new Set<string>(AUTHORITIES)
  assert.deepEqual([...AUTHORITIES], ['operator', 'caller', 'worker'])
  for (const [name, method] of Object.entries(table)) {
    assert.ok(valid.has(method.authority), `${name} has invalid authority ${String(method.authority)}`)
  }
  const operators = Object.entries(table).filter(([, m]) => m.authority === 'operator').map(([name]) => name)
  for (const required of ['approval.decide', 'credentials.set', 'credentials.status', 'workers.login', 'workers.loginRemote', 'workers.loginWait', 'workers.recheck']) {
    assert.ok(operators.includes(required), `${required} must have operator authority`)
  }
})
