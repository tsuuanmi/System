import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tableOf } from '../src/index.ts'
import { operations, type Services } from '../src/operations.ts'

const table = tableOf(operations({} as Services))

test('every row of the table says what it does', () => {
  for (const [name, method] of Object.entries(table)) assert.ok(method.summary, `${name} has no summary`)
})
