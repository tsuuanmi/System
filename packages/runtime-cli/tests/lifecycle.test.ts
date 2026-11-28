/**
 * The attempt lifecycle written once (the time limit, cancel, the whole log and prompt, the declared outputs, the result's shape),
 * with a stand-in turn in place of a Runtime.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { WorkerRequest } from '@system/work'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { runAttempt, type Turn, type TurnContext } from '../src/lifecycle.ts'

const root = mkdtempSync(join(tmpdir(), 'system-lifecycle-'))
after(() => rmSync(root, { recursive: true, force: true }))

const executor = { ref: 'x/y', account: 'y', command: 'x', version: '1' }
function request(outputs: string[], signal = new AbortController().signal): WorkerRequest {
  return { workId: 'work:test', attemptId: `attempt:${Math.random().toString(16).slice(2)}`, stepId: 's', capabilities: [], inputs: {}, outputs, signal }
}
const aborted = (ctx: TurnContext) => new Promise<void>((resolve) => { if (ctx.signal.aborted) resolve(); else ctx.signal.addEventListener('abort', () => resolve(), { once: true }) })

function run(req: WorkerRequest, turn: Turn, extra: Partial<Parameters<typeof runAttempt>[0]> = {}) {
  const { artifacts } = memoryArtifacts()
  return runAttempt({ artifacts, ref: 'x/y', executor, request: req, dir: join(root, req.attemptId.replace(/[^a-z0-9-]/gi, '_')), timeoutMinutes: 5, cancelReason: 'cancelled; stopped', log: () => 'log\n', turn, ...extra }).then((result) => ({ result, artifacts }))
}

test('the time limit stops the turn through its signal and fails with the limit named, keeping the partial outputs', async () => {
  const { result } = await run(request(['report']), async (ctx) => {
    writeFileSync(join(ctx.ws.outputs, 'report'), 'half')
    await aborted(ctx)
    return {}
  }, { timeoutMinutes: 0.0005 })
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'attempt exceeded its time limit of 0.0005 minutes')
  assert.deepEqual(result.outputs, {})
  assert.ok(result.partial?.report)
})

test('the default time limit is 60 minutes', async () => {
  let seen = ''
  const { artifacts } = memoryArtifacts()
  const real = global.setTimeout
  global.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => { if (ms === 60 * 60_000) seen = 'sixty'; return real(fn, ms, ...rest) }) as typeof setTimeout
  try {
    await runAttempt({ artifacts, ref: 'x/y', executor, request: request([]), dir: join(root, 'default-limit'), cancelReason: 'c', log: () => '', turn: async () => ({}) })
  } finally { global.setTimeout = real }
  assert.equal(seen, 'sixty')
})

test('a cancel is cancelled, not failed, with the partial outputs and the Runtime\'s reason', async () => {
  const abort = new AbortController()
  const { result } = await run(request(['report'], abort.signal), async (ctx) => {
    writeFileSync(join(ctx.ws.outputs, 'report'), 'half')
    abort.abort()
    await aborted(ctx)
    return { failure: 'would be a failure otherwise' }
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.reason, 'cancelled; stopped')
  assert.deepEqual(result.outputs, {})
  assert.ok(result.partial?.report)
  assert.ok(result.log)
})

test('a cancel before the turn starts still reaches it as an aborted signal', async () => {
  const abort = new AbortController()
  abort.abort()
  let was: boolean | undefined
  const { result } = await run(request([], abort.signal), async (ctx) => { was = ctx.signal.aborted; return {} })
  assert.equal(was, true)
  assert.equal(result.status, 'cancelled')
})

test('a stop the turn asks for fails with its reason, after a cancel and before the limit', async () => {
  const { result } = await run(request([]), async (ctx) => { ctx.stop('over budget: 1 minutes'); await aborted(ctx); return {} })
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'over budget: 1 minutes')
})

test('a declared output the turn did not write fails the attempt, naming it; one written is captured', async () => {
  const written = await run(request(['report']), async (ctx) => { writeFileSync(join(ctx.ws.outputs, 'report'), 'done'); return { message: 'hi' } })
  assert.equal(written.result.status, 'succeeded')
  assert.ok(written.result.outputs.report)
  assert.equal(written.result.message, 'hi')
  const missing = await run(request(['report', 'extra']), async (ctx) => { writeFileSync(join(ctx.ws.outputs, 'report'), 'done'); return {} })
  assert.equal(missing.result.status, 'failed')
  assert.equal(missing.result.reason, 'x/y wrote no output file for extra')
  assert.equal(missing.result.retryable, true)
  assert.deepEqual(missing.result.outputs, {})
  assert.ok(missing.result.partial?.report)
  const block = await run(request(['a']), async () => ({ captured: { outputs: {}, missing: ['a'] } }), { outputNoun: 'block', files: false })
  assert.equal(block.result.reason, 'x/y wrote no output block for a')
  assert.equal(block.result.retryable, true)
  const web = await run(request(['sources']), async () => ({ captured: { outputs: {}, missing: ['sources'] } }), { outputNoun: 'block', files: false, ref: 'web/chatgpt/default' })
  assert.equal(web.result.reason, 'web/chatgpt/default wrote no output block for sources')
  assert.equal(web.result.retryable, true)
})

test('the turn\'s own failure fails the attempt with the usage and summary it reported', async () => {
  const { result } = await run(request([]), async () => ({ failure: 'x/y exit 1: boom', usage: { inputTokens: 1 } as never, summary: { tools: 0 } as never }))
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'x/y exit 1: boom')
  assert.deepEqual(result.usage, { inputTokens: 1 })
  assert.deepEqual(result.executor, executor)
})

test('the log is stored whole as an Artifact', async () => {
  const big = `${'line of log\n'.repeat(60_000)}`
  assert.ok(big.length > 256 * 1024)
  const { result, artifacts } = await run(request([]), async () => ({}), { log: () => big })
  assert.equal(result.status, 'succeeded')
  const bytes = await artifacts.readBytes(result.log!)
  assert.equal(Buffer.from(bytes).toString(), big)
})

test('settle runs before the log is read, and what it returns joins the partial outputs; the teardown and the workspace cleanup always run', async () => {
  const order: string[] = []
  let dir = ''
  const req = request([])
  const { result } = await run(req, async (ctx) => { dir = ctx.ws.root; return {} }, {
    settle: async (r) => { order.push(`settle ${r.status}`); return { evidence: 'artifact:e' } },
    log: () => { order.push('log'); return 'l' },
    teardown: async () => { order.push('teardown') },
  })
  assert.deepEqual(order, ['settle succeeded', 'log', 'teardown'])
  assert.equal(result.partial?.evidence, 'artifact:e')
  assert.equal(existsSync(join(dir, 'work')), false)
})

test('a turn\'s cause is carried to a failed result and never to a successful one (cause-1)', async () => {
  const failed = await run(request([]), async () => ({ failure: 'the site did not take the paste', cause: 'attach' }), { files: false })
  assert.equal(failed.result.status, 'failed')
  assert.equal(failed.result.cause, 'attach')
  const ok = await run(request([]), async () => ({ cause: 'attach' }), { files: false })
  assert.equal(ok.result.status, 'succeeded')
  assert.equal('cause' in ok.result, false)
})

test('an empty or whitespace-only declared output fails the attempt, naming it; an optional one is not written', async () => {
  const empty = await run(request(['items']), async (ctx) => { writeFileSync(join(ctx.ws.outputs, 'items'), ''); return {} })
  assert.equal(empty.result.status, 'failed')
  assert.equal(empty.result.reason, 'x/y wrote an empty output file: output items is empty')
  assert.equal(empty.result.retryable, true)
  assert.deepEqual(empty.result.outputs, {})
  const blank = await run(request(['items', 'report']), async (ctx) => { writeFileSync(join(ctx.ws.outputs, 'items'), ' \n\t\n'); writeFileSync(join(ctx.ws.outputs, 'report'), 'done'); return {} })
  assert.equal(blank.result.status, 'failed')
  assert.equal(blank.result.reason, 'x/y wrote an empty output file: output items is empty')
  assert.ok(blank.result.partial?.report)
  const optional = await run({ ...request(['report']), optionalOutputs: ['extra'] }, async (ctx) => { writeFileSync(join(ctx.ws.outputs, 'report'), 'done'); writeFileSync(join(ctx.ws.outputs, 'extra'), ''); return {} })
  assert.equal(optional.result.status, 'succeeded')
  assert.equal(optional.result.outputs.extra, undefined)
  const padded = await run(request(['report']), async (ctx) => { writeFileSync(join(ctx.ws.outputs, 'report'), '  x \n'); return {} })
  assert.equal(padded.result.status, 'succeeded')
})

// Item redact-1 (RES-0016): no secret reaches a stored Artifact from an attempt.
const TOKEN = 'sk-ant-oat01-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(3)
const stored = async (r: Awaited<ReturnType<typeof run>>) => Buffer.from(await r.artifacts.readBytes(r.result.log!)).toString()
const envEvent = (content: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content }] } })

test('a stream-json log whose tool output prints an environment with a token is stored without it', async () => {
  const log = `${envEvent(`HOME=/home/a\nCLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\nPATH=/usr/bin`)}\n${JSON.stringify({ type: 'result', result: `leaked ${TOKEN}` })}\n`
  const r = await run(request([]), async () => ({}), { log: () => log })
  const text = await stored(r)
  assert.ok(!text.includes(TOKEN), text)
  assert.ok(!text.includes('A1b2C3d4E5f6'), text)
  for (const line of text.trim().split('\n')) JSON.parse(line)
})

test('the Account token is masked by value, in the log, the failure reason and the summary', async () => {
  const secret = 'plain-account-secret-value'
  const r = await run(request([]), async () => ({ failure: `exit 1: bad ${secret}`, summary: { runtime: 'claude-code', toolCalls: {}, filesRead: [`/x/${secret}`], filesEdited: [], longest: [], toolSeconds: 0, toolShare: 0, durationMs: 1, numTurns: 1 } as never }), { log: () => `echo ${secret}\n`, secrets: [secret] })
  assert.ok(!(await stored(r)).includes(secret))
  assert.ok(!r.result.reason!.includes(secret), r.result.reason)
  assert.ok(!JSON.stringify(r.result.summary).includes(secret))
  assert.match(r.result.reason!, /^exit 1: bad /)
})

test('a token in a large log is still masked', async () => {
  const filler = 'x'.repeat(100)
  const line = (n: number) => `${filler} ${n}\n`
  let text = ''
  for (let i = 0; text.length < 512 * 1024; i++) text += line(i)
  const at = text.length - 128 * 1024
  const log = `${text.slice(0, at)}ANTHROPIC_API_KEY=${TOKEN} trailing${text.slice(at)}`
  const r = await run(request([]), async () => ({}), { log: () => log })
  const out = await stored(r)
  assert.equal(out.includes('bytes cut by System'), false)
  assert.ok(!out.includes('A1b2C3d4E5f6'))
  const plain = 'ACCOUNT-SECRET-123'
  const cut = await run(request([]), async () => ({}), { log: () => `${plain}\n${text}${plain}`, secrets: [plain] })
  assert.ok(!(await stored(cut)).includes(plain))
})

test('the prompt is stored redacted as an Artifact when provided, and omitted otherwise', async () => {
  const secret = 'prompt-secret-token'
  const withPrompt = await run(request([]), async () => ({}), { prompt: () => `run with ${secret}`, secrets: [secret] })
  assert.ok(withPrompt.result.prompt)
  const storedPrompt = Buffer.from(await withPrompt.artifacts.readBytes(withPrompt.result.prompt!)).toString()
  assert.ok(!storedPrompt.includes(secret), storedPrompt)
  assert.ok(storedPrompt.startsWith('run with '))
  const withoutPrompt = await run(request([]), async () => ({}))
  assert.equal(withoutPrompt.result.prompt, undefined)
})

test('a non-secret line is unchanged', async () => {
  const log = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I read packages/a.ts and ran the tests; tokens used: 12' }] }, usage: { input_tokens: 5 } })}\nplain text line, see https://example.com/a/b\n`
  const r = await run(request([]), async () => ({ failure: 'exit 1: boom' }), { log: () => log })
  assert.equal(await stored(r), log)
  assert.equal(r.result.reason, 'exit 1: boom')
})
