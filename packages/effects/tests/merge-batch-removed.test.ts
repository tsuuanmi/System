// ct-4: the merge queue's batch mode (ct-3, `mergeBatchSize`) was removed; a profile that still sets it stops the Host at start.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

test('ct-4: a config that still sets mergeBatchSize, whatever the value, is refused at start and says it was removed', () => {
  for (const size of [3, 1, 0, 'x']) {
    assert.throws(() => apply({} as Context, { mergeBatchSize: size } as never), (error: Error) => /mergeBatchSize/.test(error.message) && /removed/.test(error.message))
  }
})
