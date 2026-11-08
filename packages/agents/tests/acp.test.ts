import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { Artifacts } from '@system/artifacts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { TASK_KIND, taskSchema, type WorkerRequest } from '@system/work'
import { agentWorker, type Account, type Spawner } from '../src/agent.ts'
import { acpInvocation, parseAcp, progressReader } from '../src/runtimes.ts'

const root = mkdtempSync(join(tmpdir(), 'system-acp-'))
after(() => rmSync(root, { recursive: true, force: true }))

test('ACP NDJSON requires an explicit EndTurn and fails closed on permission denial', () => {
  const result = (ok: boolean, stopReason: string) => JSON.stringify({ type: 'acp.result', ok, stopReason })
  assert.equal(parseAcp(result(true, 'EndTurn')).ok, true)
  assert.equal(parseAcp(result(true, 'Cancelled')).ok, false)
  assert.equal(parseAcp(result(false, 'EndTurn')).ok, false)
  assert.equal(parseAcp('garbage').ok, false)
  const denied = [JSON.stringify({ type: 'acp.permission_denied' }), result(true, 'EndTurn')].join('\n')
  assert.equal(parseAcp(denied).ok, false)
  assert.equal(parseAcp(result(true, 'EndTurn')).usage, undefined, 'do not fake token usage')
})

test('ACP invocation keeps argv separate, prompt private, and no host secrets', () => {
  const ws = { home: '/sandbox/home', inputs: '/sandbox/in', outputs: '/sandbox/out', work: '/sandbox/work' } as Parameters<typeof acpInvocation>[1]
  const invocation = acpInvocation('system-acp-bridge', ws, '/sandbox/prompt', '/agent with space', ['--a', 'two words'], 'only-worker-token')
  assert.deepEqual(invocation.argv, [
    'system-acp-bridge', '--agent', '/agent with space', '--args-json', JSON.stringify(['--a', 'two words']), '--prompt-file', '/sandbox/prompt',
  ])
  assert.equal(invocation.env.CLAUDE_CODE_OAUTH_TOKEN, 'only-worker-token')
  assert.equal(invocation.env.GITHUB_TOKEN, undefined)
  assert.equal(invocation.env.NO_BROWSER, '1')
  const progress = progressReader('acp')
  assert.deepEqual(progress('{"type":"acp.initialized"}\n'), { stage: 'acp.initialized' })
})

function fixture() {
  return memoryArtifacts({ ...TASK_KIND, content: taskSchema })
}

const account = (): Account => ({
  ref: 'acp/mock', runtime: 'acp', capabilities: ['research'],
  command: '/mock/rust-bridge', version: async () => '0.1.0',
  acp: { agentCommand: '/mock/acp-agent', agentArgs: ['--demo', 'one two'] },
})

const request = (input: string, signal = new AbortController().signal): WorkerRequest => ({
  workId: 'work:acp', attemptId: 'attempt:acp-test', stepId: 'report',
  capabilities: ['research'], inputs: { question: input }, outputs: ['report'], signal,
})

async function task(artifacts: Artifacts): Promise<string> {
  return (await artifacts.put({
    ...TASK_KIND, content: { instructions: 'Summarize the fixture' },
    classification: 'local-private', producer: { type: 'operator', ref: 'test' },
  })).id
}

test('ACP via WorkerPort captures exact Artifact result with no runtime-specific controller', async () => {
  const { artifacts } = fixture()
  let observedArgs: string[] = []
  const spawner: Spawner = {
    spawn(spec) {
      observedArgs = spec.argv
      const path = spec.argv.at(-1)!
      const prompt = readFileSync(path, 'utf8')
      assert.match(prompt, /Summarize the fixture/)
      writeFileSync(join(dirname(spec.cwd), 'out', 'report'), '# ACP report\n')
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        stdout: () => JSON.stringify({ type: 'acp.result', ok: true, stopReason: 'EndTurn' }),
        stderr: () => '',
      }
    },
  }
  const worker = agentWorker(account(), artifacts, spawner, join(root, 'attempts'))
  const result = await worker.run(request(await task(artifacts)))
  assert.equal(result.status, 'succeeded', result.reason)
  assert.equal(result.usage, undefined)
  assert.ok(result.outputs.report?.startsWith('sha256:'))
  assert.deepEqual(observedArgs.slice(0, 2), ['/mock/rust-bridge', '--agent'])
  assert.equal(Buffer.from(await artifacts.readBytes(result.outputs.report!)).toString('utf8'), '# ACP report\n')
})

test('ACP permission refusal does not become a successful Worker result', async () => {
  const { artifacts } = fixture()
  const spawner: Spawner = {
    spawn(spec) {
      writeFileSync(join(dirname(spec.cwd), 'out', 'report'), 'unapproved content')
      return {
        done: Promise.resolve({ exitCode: 1, signal: null }),
        stdout: () => '{"type":"acp.permission_denied"}\n{"type":"acp.result","ok":true,"stopReason":"EndTurn"}',
        stderr: () => 'rejected',
      }
    },
  }
  const result = await agentWorker(account(), artifacts, spawner, join(root, 'denied'))
    .run(request(await task(artifacts)))
  assert.equal(result.status, 'failed')
  assert.equal(result.outputs.report, undefined)
  assert.ok(result.partial?.report, 'partial work is recorded but not accepted')
})
