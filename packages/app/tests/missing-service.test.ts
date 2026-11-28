/**
 * plug-14 (ADR-0017 decision 4): `system-app` declares every service it reads. A Host composed without the `work` row
 * runs `system host`, and the app names the missing service and exits 1 (it does not throw from a service it never declared).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as app from '../src/index.ts'

test('system host without the work row reports the missing service', async () => {
  const root = new Context()
  const exits: number[] = []
  const done = new Promise<void>((resolve) => { root.provide('appExit', ((code: number) => { exits.push(code); resolve() }) as never) })
  root.provide('cmdlineArgs', { get: () => ['host'] } as never)
  // Every service but `work` is there.
  root.provide('artifacts', {} as never)
  root.provide('capabilities', {} as never)
  const written: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true }) as never
  try {
    await (root.plugin as (plugin: unknown, config: unknown) => PromiseLike<unknown>).call(root, app, {})
    await done
  } finally {
    process.stderr.write = write
  }
  assert.deepEqual(exits, [1])
  assert.match(written.join(''), /the work service is not available \(run `system doctor`\)/)
  assert.doesNotMatch(written.join(''), /artifacts|capabilities/, 'only the missing service is named')
})
