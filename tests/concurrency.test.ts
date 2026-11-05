/**
 * Several `system` processes on one profile at once: every command boots its
 * own host on the same SQLite store, and none may fail with "database is
 * locked" (each host opens and writes the store while the others do).
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

before(() => {
  assert.equal(cli.run(['init']).status, 0)
})

after(() => rmSync(cli.home, { recursive: true, force: true }))

test('parallel commands that write the store all succeed', async () => {
  const failures: string[] = []
  for (let round = 0; round < 8; round++) {
    const files = [0, 1, 2, 3].map((i) => {
      const file = join(cli.home, `input-${round}-${i}.txt`)
      writeFileSync(file, `round ${round} file ${i}\n`)
      return file
    })
    const results = await Promise.all([
      ...files.map((file) => runAsync(['artifact', 'put', file])),
      runAsync(['doctor']),
      runAsync(['doctor']),
    ])
    for (const r of results) if (r.status !== 0) failures.push(r.stderr.split('\n').find((l) => l.trim()) ?? `exit ${r.status}`)
  }
  assert.deepEqual(failures, [])
})
