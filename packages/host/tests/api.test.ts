import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { apiReference } from '../src/api.ts'
import { tableOf } from '../src/index.ts'
import { operations, type Services } from '../src/operations.ts'

const readme = new URL('../README.md', import.meta.url)
const BEGIN = '<!-- api:begin: generated from the operation table; `SYSTEM_DOCS_WRITE=1 corepack pnpm test` rewrites it -->'
const END = '<!-- api:end -->'
const table = tableOf(operations({} as Services))

test('every row of the table says what it does', () => {
  for (const [name, method] of Object.entries(table)) assert.ok(method.summary, `${name} has no summary`)
})

test('the README lists exactly the table\'s methods, flags and params', () => {
  const text = readFileSync(readme, 'utf8')
  const from = text.indexOf(BEGIN)
  const to = text.indexOf(END)
  assert.ok(from >= 0 && to > from, `the README needs ${BEGIN} and ${END} around the API reference`)
  const expected = `${BEGIN}\n\n${apiReference(table)}\n\n${END}`
  if (process.env.SYSTEM_DOCS_WRITE) writeFileSync(readme, text.slice(0, from) + expected + text.slice(to + END.length))
  else assert.equal(text.slice(from, to + END.length), expected, 'the README is out of date with the table: run SYSTEM_DOCS_WRITE=1 corepack pnpm test')
})
