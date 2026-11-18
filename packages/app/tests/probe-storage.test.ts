/**
 * The doctor's storage probe on a store several processes probe at once: each
 * `system doctor` writes a record and reads it back, and a record another
 * process wrote in between must not read as a failure (the concurrency smoke
 * test failed under load with "read back a different record").
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { probeStorage } from '../src/index.ts'

/** One shared table (the store), as every process's domain sees it; each put yields so probes interleave. */
function sharedStore() {
  const rows = new Map<string, { at: string }>()
  const context = () => ({
    get: (name: string) => name === 'storage'
      ? { backend: { get: () => ({}) } }
      : { open: async () => ({
          table: () => ({
            put: async (key: string, value: { at: string }) => { await new Promise((r) => setImmediate(r)); rows.set(key, value) },
            get: (key: string) => rows.get(key),
            delete: async (key: string) => rows.delete(key),
          }),
          close: async () => undefined,
        }) },
  })
  return { rows, context }
}

test('probes of one store running together all read back what they wrote', async () => {
  const { rows, context } = sharedStore()
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    await new Promise((r) => setTimeout(r, i)) // different timestamps
    return probeStorage(context() as never)
  }))
  assert.deepEqual(results.map((r) => r.detail), results.map(() => 'durable write and read back'))
  assert.equal(rows.size, 0, 'a probe leaves no record behind')
})
