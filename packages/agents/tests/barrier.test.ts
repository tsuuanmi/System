/**
 * Smoke-fast-1: the condition-based barrier in fake-agent.mjs (replacing the fixed FAKE:delay=8000 wait)
 * genuinely blocks until the required number of arrivals appear and fails if the condition is never met.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs')

function runAgent(prompt: string) {
  const child = spawn(process.execPath, [fakeAgent, '-p', prompt], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (d) => { stdout += d })
  const done = new Promise<{ code: number | null; stdout: string }>((resolve) => child.on('exit', (code) => resolve({ code, stdout })))
  return { child, done }
}

test('FAKE:barrier waits until the required count of arrivals appears, then finishes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-barrier-'))
  try {
    const agent = runAgent(`FAKE:barrier=${dir}:2`)
    const deadline = Date.now() + 10_000
    while (readdirSync(dir).length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    assert.equal(readdirSync(dir).length, 1, 'the agent wrote its own arrival marker')
    assert.equal(agent.child.exitCode, null, 'the agent is still waiting for the second arrival')
    writeFileSync(join(dir, 'second'), '')
    const result = await agent.done
    assert.equal(result.code, 0, result.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FAKE:barrier fails when the required count is never reached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-barrier-fail-'))
  try {
    const agent = runAgent(`FAKE:barrier=${dir}:2:150`)
    const result = await agent.done
    assert.equal(result.code, 1)
    assert.match(result.stdout, /did not reach 2/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
