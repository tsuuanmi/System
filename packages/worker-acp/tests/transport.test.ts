import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { SubprocessRuntime, SubprocessSpawnSpec, SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { dshAcpRunner } from '../src/transport.ts'

const root = mkdtempSync(join(tmpdir(), 'system-acp-wire-'))
after(() => rmSync(root, { recursive: true, force: true }))
const fixture = new URL('./mock-agent.mjs', import.meta.url).pathname

function fakeSubprocess(): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const child = spawn(spec.argv[0]!, [...spec.argv].slice(1), {
        cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      const done: Promise<SubprocessOutcome> = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
      })
      let exited = false
      void done.finally(() => { exited = true }).catch(() => {})
      return {
        stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, control: undefined,
        collected: {},
        done,
        terminate: () => { child.kill('SIGTERM') },
        waitForExit: async (signal?: AbortSignal) => {
          if (exited) return true
          if (signal?.aborted) return false
          return await new Promise<boolean>((resolve) => {
            let settled = false
            const finish = (value: boolean) => {
              if (settled) return
              settled = true
              signal?.removeEventListener('abort', aborted)
              resolve(value)
            }
            const aborted = () => finish(false)
            if (signal) signal.addEventListener('abort', aborted, { once: true })
            void done.then(() => finish(true), () => finish(true))
          })
        },
      }
    },
  } as unknown as SubprocessRuntime
}

const run = (env: NodeJS.ProcessEnv = {}, controller = new AbortController()) =>
  dshAcpRunner(fakeSubprocess()).run({
    command: process.execPath, args: [fixture], cwd: root,
    env, prompt: 'Use ACP v1', signal: controller.signal,
    pidFile: join(root, 'acp.pid'),
  })

test('official ACP TypeScript SDK negotiates v1, creates session and sends one prompt', async () => {
  const result = await run()
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(result.permissionDenied, false)
  assert.equal(result.exitCode, 0)
  assert.ok(result.events.some((event) => event.includes('"initialized"')))
})

test('ACP permission prompts are denied even if the agent returns end_turn', async () => {
  const result = await run({ MOCK_PERMISSION: '1' })
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(result.permissionDenied, true)
})

test('abnormal ACP stop reason cannot be treated as success by WorkerPort', async () => {
  const result = await run({ MOCK_STOP_REASON: 'cancelled' })
  assert.equal(result.stopReason, 'cancelled')
})

test('hanging ACP initialization can be aborted and reaps its child process', async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 200)
  try {
    await assert.rejects(run({ MOCK_HANG: 'initialize' }, controller))
  } finally {
    clearTimeout(timer)
  }
})
