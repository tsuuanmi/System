/**
 * `system schema` prints the operation table as JSON; the MCP tools and their
 * annotations come from the same table (Item schema-1).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { operations, type Services } from '../../host/src/operations.ts'
import { tableOf } from '../../host/src/index.ts'
import { buildProgram, type Run } from '../src/cli.ts'
import { tools } from '../src/mcp.ts'
import { fakeHost } from './fake-host.ts'

const table = tableOf(operations({} as Services))

async function printed(): Promise<any[]> {
  let out = ''
  let run: Run | undefined
  const program = buildProgram(fakeHost(), { out: (t: string) => { out += t }, err() {} } as any, (r) => { run = r })
  program.exitOverride()
  await program.parseAsync(['node', 'system', 'schema'])
  assert.equal(await run!(), 0)
  return JSON.parse(out)
}

test('every operation has a summary', () => {
  for (const [name, row] of Object.entries(table)) assert.ok(row.summary && row.summary.trim().length > 0, `${name} has no summary`)
})

test('system schema prints one entry per operation: name, summary, authority, access, parameters', async () => {
  const schema = await printed()
  assert.deepEqual(schema.map((o) => o.name).sort(), Object.keys(table).sort())
  for (const op of schema) {
    const row = table[op.name]!
    assert.equal(op.summary, row.summary)
    assert.equal(op.authority, row.authority)
    assert.equal(op.access, row.read ? 'read' : 'write')
    assert.equal(op.params.type, 'object')
  }
  const submit = schema.find((o) => o.name === 'work.submit')
  assert.ok(Object.hasOwn(submit.params.properties, 'workflow'))
})

test('the printed table matches the registered MCP tools, with their annotations', async () => {
  const schema = (await printed()).filter((o) => o.authority === 'caller')
  assert.deepEqual(tools.map((t) => t.name).sort(), schema.map((o) => o.name).sort())
  for (const tool of tools) {
    const op = schema.find((o) => o.name === tool.name)
    assert.equal(tool.description, op.summary)
    assert.deepEqual(tool.inputSchema, op.params)
    assert.equal(tool.annotations.readOnlyHint, op.access === 'read')
    assert.equal(tool.annotations.destructiveHint, op.access === 'write' && op.destructive)
  }
  assert.equal(tools.find((t) => t.name === 'work.show')!.annotations.readOnlyHint, true)
  assert.equal(tools.find((t) => t.name === 'work.cancel')!.annotations.destructiveHint, true)
  assert.equal(tools.find((t) => t.name === 'work.run')!.annotations.destructiveHint, false)
})
