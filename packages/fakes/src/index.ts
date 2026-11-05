/**
 * The `fakes` row: a scripted Worker and verifier for offline tests and
 * demonstrations. Disabled in the System bundle; a profile patch enables it.
 *
 * Environment hooks (tests only):
 * - SYSTEM_FAKE_LOG=<file>: append "<workId> <stepId> <attemptId>" per Worker call.
 * - SYSTEM_FAKE_CRASH_AT=<stepId>: SIGKILL the host when that step is dispatched.
 * - SYSTEM_FAKE_FAIL=<stepId>: that step's Worker reports failure.
 * - SYSTEM_FAKE_VERDICT=<pass|fail|inconclusive|error>: every verdict (default pass).
 */
import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Artifacts } from '@system/artifacts'
import type { Capabilities, VerifyResult } from '@system/work'
import { z } from 'zod'

export const name = 'system-fakes'
export const inject = ['capabilities', 'artifacts']

export interface Config {
  workers?: string[]
  verifiers?: string[]
}

const VERDICTS = ['pass', 'fail', 'inconclusive', 'error'] as const

export function apply(ctx: Context, config: Config = {}): void {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  artifacts.registerKind({
    kind: 'fake-output', schemaVersion: 1,
    content: z.object({ stepId: z.string(), slot: z.string(), inputs: z.record(z.string(), z.string()), attemptId: z.string() }).strict(),
  })
  const dispose = [
    capabilities.registerWorker({
      ref: 'fake-worker',
      capabilities: config.workers ?? [],
      async run(request) {
        if (process.env.SYSTEM_FAKE_LOG) appendFileSync(process.env.SYSTEM_FAKE_LOG, `${request.workId} ${request.stepId} ${request.attemptId}\n`)
        if (process.env.SYSTEM_FAKE_CRASH_AT === request.stepId) process.kill(process.pid, 'SIGKILL')
        if (process.env.SYSTEM_FAKE_FAIL === request.stepId) return { status: 'failed', outputs: {}, reason: 'scripted failure' }
        const outputs: Record<string, string> = {}
        for (const slot of request.outputs) {
          const stored = await artifacts.put({
            kind: 'fake-output', schemaVersion: 1,
            content: { stepId: request.stepId, slot, inputs: request.inputs, attemptId: request.attemptId },
            inputs: Object.values(request.inputs), classification: 'public',
            producer: { type: 'worker', ref: 'fake-worker' }, workId: request.workId, attemptId: request.attemptId,
          })
          outputs[slot] = stored.id
        }
        return { status: 'succeeded', outputs }
      },
    }),
    capabilities.registerVerifier({
      ref: 'fake-verifier',
      capabilities: config.verifiers ?? [],
      async verify(request): Promise<VerifyResult> {
        const verdict = (VERDICTS as readonly string[]).includes(process.env.SYSTEM_FAKE_VERDICT ?? '') ? process.env.SYSTEM_FAKE_VERDICT as VerifyResult['verdict'] : 'pass'
        return { verdict, reason: `scripted ${verdict} for ${request.subject} against ${request.criteria}` }
      },
    }),
  ]
  ctx.effect(() => () => { for (const d of dispose) d() }, 'fake registrations')
}
