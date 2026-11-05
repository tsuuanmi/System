/**
 * The `fakes` row: a scripted Worker and verifier for offline tests and
 * demonstrations. Disabled in the System bundle; a profile patch enables it.
 *
 * Environment hooks (tests only):
 * - SYSTEM_FAKE_LOG=<file>: append "<workId> <stepId> <attemptId>" per Worker call.
 * - SYSTEM_FAKE_CRASH_AT=<stepId>: SIGKILL the host when that step is dispatched.
 * - SYSTEM_FAKE_FAIL=<stepId>: that step's Worker reports failure.
 * - SYSTEM_FAKE_SLEEP_AT=<stepId>: that step's Worker waits until it is cancelled,
 *   then reports `cancelled` with one partial output.
 * - SYSTEM_FAKE_VERDICT=<pass|fail|inconclusive|error>: every verdict (default pass).
 *
 * The fake effect provider "publishes" into `$DSH_HOME/system/fake-effects.json`
 * (operation ID -> subject), so reconciliation works across host processes.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Artifacts } from '@system/artifacts'
import { systemPath, type Capabilities, type VerifyResult, type WorkerRequest } from '@system/work'
import { z } from 'zod'

export const name = 'system-fakes'
export const inject = ['capabilities', 'artifacts']

export interface Config {
  workers?: string[]
  verifiers?: string[]
  effects?: string[]
}

const VERDICTS = ['pass', 'fail', 'inconclusive', 'error'] as const

export function apply(ctx: Context, config: Config = {}): void {
  const capabilities = ctx.get('capabilities') as Capabilities
  const artifacts = ctx.get('artifacts') as Artifacts
  artifacts.registerKind({
    kind: 'fake-output', schemaVersion: 1,
    content: z.object({ stepId: z.string(), slot: z.string(), inputs: z.record(z.string(), z.string()), attemptId: z.string(), state: z.enum(['complete', 'partial']) }).strict(),
  })
  artifacts.registerKind({ kind: 'fake-criteria', schemaVersion: 1, content: z.object({ capability: z.string(), name: z.string() }).strict() })
  const put = async (request: WorkerRequest, slot: string, state: 'complete' | 'partial') => (await artifacts.put({
    kind: 'fake-output', schemaVersion: 1,
    content: { stepId: request.stepId, slot, inputs: request.inputs, attemptId: request.attemptId, state },
    inputs: Object.values(request.inputs), classification: 'public',
    producer: { type: 'worker', ref: 'fake-worker' }, workId: request.workId, attemptId: request.attemptId,
  })).id
  const dispose = [
    capabilities.registerWorker({
      ref: 'fake-worker',
      capabilities: config.workers ?? [],
      async run(request) {
        if (process.env.SYSTEM_FAKE_LOG) appendFileSync(process.env.SYSTEM_FAKE_LOG, `${request.workId} ${request.stepId} ${request.attemptId}\n`)
        if (process.env.SYSTEM_FAKE_CRASH_AT === request.stepId) process.kill(process.pid, 'SIGKILL')
        if (process.env.SYSTEM_FAKE_FAIL === request.stepId) return { status: 'failed', outputs: {}, reason: 'scripted failure' }
        if (process.env.SYSTEM_FAKE_SLEEP_AT === request.stepId) {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve()
            else request.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          const partial = await put(request, request.outputs[0]!, 'partial')
          return { status: 'cancelled', outputs: {}, partial: { [request.outputs[0]!]: partial }, reason: 'stopped when cancelled' }
        }
        const outputs: Record<string, string> = {}
        for (const slot of request.outputs) outputs[slot] = await put(request, slot, 'complete')
        return { status: 'succeeded', outputs, executor: { ref: 'fake-worker' } }
      },
    }),
    capabilities.registerVerifier({
      ref: 'fake-verifier',
      version: '1',
      capabilities: config.verifiers ?? [],
      accepts: ['fake-output'],
      async criteria(request) {
        return (await artifacts.put({
          kind: 'fake-criteria', schemaVersion: 1, content: { capability: request.capability, name: request.name },
          classification: 'public', producer: { type: 'verifier', ref: 'fake-verifier' },
        })).id
      },
      async verify(request): Promise<VerifyResult> {
        const verdict = (VERDICTS as readonly string[]).includes(process.env.SYSTEM_FAKE_VERDICT ?? '') ? process.env.SYSTEM_FAKE_VERDICT as VerifyResult['verdict'] : 'pass'
        const evidence = (await artifacts.put({
          kind: 'fake-criteria', schemaVersion: 1, content: { capability: request.capability, name: `evidence for ${request.subject}` },
          classification: 'public', producer: { type: 'verifier', ref: 'fake-verifier' },
        })).id
        return { verdict, reason: `scripted ${verdict}`, subject: request.subject, criteria: request.criteria, evidence: [evidence] }
      },
    }),
  ]
  const published = systemPath(ctx, 'fake-effects.json')
  const read = (): Record<string, string> => (existsSync(published) ? JSON.parse(readFileSync(published, 'utf8')) as Record<string, string> : {})
  dispose.push(capabilities.registerEffect({
    ref: 'fake-publisher', version: '1', capabilities: config.effects ?? [], accepts: ['fake-output'],
    validate: () => undefined,
    approval: () => undefined,
    async apply(intent) {
      writeFileSync(published, JSON.stringify({ ...read(), [intent.operationId]: intent.subject }))
      return { state: 'applied', reason: 'published (fake)', detail: { subject: intent.subject } }
    },
    async reconcile(intent) {
      const subject = read()[intent.operationId]
      return subject ? { state: 'applied', reason: 'found (fake)', detail: { subject } } : { state: 'absent', reason: 'not published (fake)' }
    },
  }))
  ctx.effect(() => () => { for (const d of dispose) d() }, 'fake registrations')
}
