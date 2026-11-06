/**
 * Several `system` processes on one profile at once: every command boots its
 * own host on the same SQLite store, and none may fail with "database is
 * locked" (each host opens and writes the store while the others do), even
 * when they all find the store missing and create it together.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-concurrency')

function runAsync(args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repo, 'bin', 'system'), ...args], { env: cli.env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stderr }))
  })
}

/** Rounds of four Artifact writes and two boots in parallel; returns every complaint. */
async function rounds(count: number, prepare: () => void = () => undefined): Promise<string[]> {
  const failures: string[] = []
  for (let round = 0; round < count; round++) {
    prepare()
    const files = [0, 1, 2, 3].map((i) => {
      const file = join(cli.home, `input-${round}-${i}-${Math.random()}.txt`)
      writeFileSync(file, `round ${round} file ${i} ${file}\n`)
      return file
    })
    const results = await Promise.all([
      ...files.map((file) => runAsync(['artifact', 'put', file])),
      runAsync(['doctor']),
      runAsync(['doctor']),
    ])
    for (const r of results) if (r.status !== 0 || r.stderr.trim()) failures.push(r.stderr.trim() || `exit ${r.status}`)
  }
  return failures
}

before(() => {
  assert.equal(cli.run(['init']).status, 0)
})

after(() => rmSync(cli.home, { recursive: true, force: true }))

test('parallel commands that write the store all succeed', async () => {
  assert.deepEqual(await rounds(8), [])
})

test('parallel commands that all find the store missing create it together without failing', async () => {
  const store = join(cli.home, 'system', 'state.sqlite')
  const fresh = () => { for (const suffix of ['', '-wal', '-shm']) rmSync(store + suffix, { force: true }) }
  assert.deepEqual(await rounds(12, fresh), [])
})
