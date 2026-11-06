/**
 * Several `system` processes on one profile at once: every `doctor` boots DSH
 * on the same SQLite store (beside the Host, when one runs), and none may fail
 * with "database is locked" (each opens and writes the store while the others
 * do), even when they all find the store missing and create it together.
 */
import assert from 'node:assert/strict'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-concurrency')

const runAsync = (args: string[]) => cli.runAsync(args).done

/** Rounds of `writes` Artifact writes (through the Host) and `boots` boots in parallel; returns every complaint. */
async function rounds(count: number, writes: number, boots: number, prepare: () => void = () => undefined): Promise<string[]> {
  const failures: string[] = []
  for (let round = 0; round < count; round++) {
    prepare()
    const files = Array.from({ length: writes }, (_, i) => i).map((i) => {
      const file = join(cli.home, `input-${round}-${i}-${Math.random()}.txt`)
      writeFileSync(file, `round ${round} file ${i} ${file}\n`)
      return file
    })
    const results = await Promise.all([
      ...files.map((file) => runAsync(['artifact', 'put', file])),
      ...Array.from({ length: boots }, () => runAsync(['doctor'])),
    ])
    for (const r of results) if (r.status !== 0 || r.stderr.trim()) failures.push(r.stderr.trim() || `exit ${r.status}`)
  }
  return failures
}

before(() => {
  assert.equal(cli.run(['init']).status, 0)
})

after(async () => {
  await cli.stop()
  rmSync(cli.home, { recursive: true, force: true })
})

test('parallel commands that write the store all succeed', { timeout: 240_000 }, async () => {
  await cli.start()
  try {
    assert.deepEqual(await rounds(8, 4, 2), [])
  } finally {
    await cli.stop()
  }
})

test('parallel commands that all find the store missing create it together without failing', { timeout: 240_000 }, async () => {
  const store = join(cli.home, 'system', 'state.sqlite')
  const fresh = () => { for (const suffix of ['', '-wal', '-shm']) rmSync(store + suffix, { force: true }) }
  assert.deepEqual(await rounds(12, 0, 6, fresh), [])
})

test('a boot does not rewrite the profile root config another booting host may be reading', async () => {
  // DSH rewrote profiles/system/cordis.yml (truncate, then write) on every
  // boot, so a host booting alongside could read it empty and fail.
  const config = join(cli.home, 'profiles', 'system', 'cordis.yml')
  assert.equal((await runAsync(['doctor'])).status, 0, 'a first boot writes it')
  const before = statSync(config)
  await new Promise((r) => setTimeout(r, 20))
  const ran = await runAsync(['doctor'])
  assert.equal(ran.status, 0, ran.stderr)
  const after = statSync(config)
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs])
})
