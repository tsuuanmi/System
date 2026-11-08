import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { Artifacts } from '@system/artifacts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { TASK_KIND, taskSchema, type WorkerRequest } from '@system/work'
import type { Spawner } from '@system/worker-execution'
import { acpWorker, type AcpAccount } from '../src/worker.ts'
import { acpInvocation, acpProgress, parseAcp } from '../src/protocol.ts'

const root = mkdtempSync(join(tmpdir(), 'system-acp-'))
after(() => rmSync(root, { recursive: true, force: true }))
const result = (ok: boolean, stopReason: string) => JSON.stringify({ type: 'acp.result', ok, stopReason })

test('ACP parse requires one complete EndTurn and no denied permission', () => {
  assert.equal(parseAcp(result(true, 'EndTurn')).ok, true)
  assert.equal(parseAcp(result(true, 'Cancelled')).ok, false)
  assert.equal(parseAcp(result(false, 'EndTurn')).ok, false)
  assert.equal(parseAcp('garbage').ok, false)
  assert.equal(parseAcp([result(true, 'EndTurn'), result(true, 'EndTurn')].join('\n')).ok, false)
  const denied = ['{"type":"acp.permission_denied"}', result(true, 'EndTurn')].join('\n')
  assert.equal(parseAcp(denied).ok, false)
})

test('ACP invocation preserves argv, prompt secrecy, scoped environment and unknown usage', () => {
  const ws = { home: '/sandbox/home', inputs: '/sandbox/in', outputs: '/sandbox/out', work: '/sandbox/work' } as Parameters<typeof acpInvocation>[1]
  const invocation = acpInvocation('system-acp-bridge', ws, '/sandbox/prompt', '/agent with space', ['--a', 'two words'], 'only-worker-token')
  assert.deepEqual(invocation.argv, [
    'system-acp-bridge', '--agent', '/agent with space', '--args-json', '["--a","two words"]',
    '--prompt-file', '/sandbox/prompt',
  ])
  assert.equal(invocation.env.CLAUDE_CODE_OAUTH_TOKEN, 'only-worker-token')
  assert.equal(invocation.env.GITHUB_TOKEN, undefined)
  assert.deepEqual(acpProgress()('{"type":"acp.initialized"}\n'), { stage: 'acp.initialized' })
})

const account = (): AcpAccount => ({
  ref: 'acp/mock', capabilities: ['research'],
  command: '/mock/rust-bridge', version: async () => '0.1.0',
  agentCommand: '/mock/acp-agent', agentArgs: ['--demo', 'one two'],
})
const request = (input: string, signal = new AbortController().signal): WorkerRequest => ({
  workId: 'work:acp', attemptId: 'attempt:acp-test', stepId: 'report',
  capabilities: ['research'], inputs: { question: input }, outputs: ['report'], signal,
})
function fixture() { return memoryArtifacts({ ...TASK_KIND, content: taskSchema }) }
async function task(artifacts: Artifacts): Promise<string> {
  return (await artifacts.put({
    ...TASK_KIND, content: { instructions: 'Summarize the fixture' },
    classification: 'local-private', producer: { type: 'operator', ref: 'test' },
  })).id
}

test('independent ACP WorkerPort captures exact Artifact with the same output contract', async () => {
  const { artifacts } = fixture()
  let observed: string[] = []
  const spawner: Spawner = {
    spawn(spec) {
      observed = spec.argv
      const prompt = readFileSync(spec.argv.at(-1)!, 'utf8')
      assert.match(prompt, /Summarize the fixture/)
      writeFileSync(join(dirname(spec.cwd), 'out', 'report'), '# ACP report\n')
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        stdout: () => result(true, 'EndTurn'),
        stderr: () => '',
      }
    },
  }
  const done = await acpWorker(account(), artifacts, spawner, join(root, 'attempts')).run(request(await task(artifacts)))
  assert.equal(done.status, 'succeeded', done.reason)
  assert.equal(done.usage, undefined, 'no fabricated token usage')
  assert.ok(done.outputs.report?.startsWith('sha256:'))
  assert.deepEqual(observed.slice(0, 2), ['/mock/rust-bridge', '--agent'])
  assert.equal(Buffer.from(await artifacts.readBytes(done.outputs.report!)).toString(), '# ACP report\n')
})

test('permission denial returns failure with unaccepted partial output', async () => {
  const { artifacts } = fixture()
  const spawner: Spawner = {
    spawn(spec) {
      writeFileSync(join(dirname(spec.cwd), 'out', 'report'), 'unapproved content')
      return {
        done: Promise.resolve({ exitCode: 1, signal: null }),
        stdout: () => ['{"type":"acp.permission_denied"}', result(true, 'EndTurn')].join('\n'),
        stderr: () => '',
      }
    },
  }
  const done = await acpWorker(account(), artifacts, spawner, join(root, 'denied')).run(request(await task(artifacts)))
  assert.equal(done.status, 'failed')
  assert.equal(done.outputs.report, undefined)
  assert.ok(done.partial?.report)
})

test('operator cancel is distinct from failed ACP turn', async () => {
  const { artifacts } = fixture()
  const cancel = new AbortController()
  const spawner: Spawner = {
    spawn(spec) {
      cancel.abort()
      assert.equal(spec.signal.aborted, true)
      return {
        done: Promise.resolve({ exitCode: null, signal: 'SIGTERM' }),
        stdout: () => '',
        stderr: () => '',
      }
    },
  }
  const done = await acpWorker(account(), artifacts, spawner, join(root, 'cancel')).run(request(await task(artifacts), cancel.signal))
  assert.equal(done.status, 'cancelled')
})
