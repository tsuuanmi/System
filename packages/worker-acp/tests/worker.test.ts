import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { Artifacts } from '@system/artifacts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { TASK_KIND, taskSchema, type WorkerRequest } from '@system/work'
import { acpWorker, type AcpAccount } from '../src/worker.ts'
import type { AcpRunner } from '../src/transport.ts'

const root = mkdtempSync(join(tmpdir(), 'system-acp-'))
after(() => rmSync(root, { recursive: true, force: true }))

const account = (): AcpAccount => ({
  ref: 'acp/mock', capabilities: ['research'],
  agentCommand: '/mock/agent', agentArgs: ['--demo', 'two words'],
  version: async () => 'acp-test',
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

test('ACP plugin WorkerPort uses identical exact Artifact contract without fabricated usage', async () => {
  const { artifacts } = fixture()
  const runner: AcpRunner = {
    async run(spec) {
      assert.equal(spec.command, '/mock/agent')
      assert.deepEqual(spec.args, ['--demo', 'two words'])
      assert.match(spec.prompt, /Summarize the fixture/)
      assert.equal(spec.env.GITHUB_TOKEN, undefined)
      writeFileSync(join(dirname(spec.cwd), 'out', 'report'), '# ACP report\n')
      spec.onStage?.('initialized')
      return { stopReason: 'end_turn', permissionDenied: false, events: [], exitCode: 0 }
    },
  }
  const done = await acpWorker(account(), artifacts, runner, join(root, 'success')).run(request(await task(artifacts)))
  assert.equal(done.status, 'succeeded', done.reason)
  assert.equal(done.usage, undefined)
  assert.ok(done.outputs.report?.startsWith('sha256:'))
  assert.equal(Buffer.from(await artifacts.readBytes(done.outputs.report!)).toString(), '# ACP report\n')
  assert.equal(done.executor?.command, '/mock/agent')
})

test('ACP permission denial never turns an EndTurn into accepted Work', async () => {
  const { artifacts } = fixture()
  const runner: AcpRunner = {
    async run(spec) {
      writeFileSync(join(dirname(spec.cwd), 'out', 'report'), 'unapproved output')
      return { stopReason: 'end_turn', permissionDenied: true, events: [], exitCode: 0 }
    },
  }
  const done = await acpWorker(account(), artifacts, runner, join(root, 'permission')).run(request(await task(artifacts)))
  assert.equal(done.status, 'failed')
  assert.equal(done.outputs.report, undefined)
  assert.ok(done.partial?.report)
})

test('cancelled Work remains cancelled rather than an ACP success', async () => {
  const { artifacts } = fixture()
  const cancel = new AbortController()
  const runner: AcpRunner = {
    async run(spec) {
      cancel.abort()
      assert.equal(spec.signal.aborted, true)
      throw new Error('subprocess cancelled')
    },
  }
  const done = await acpWorker(account(), artifacts, runner, join(root, 'cancelled'))
    .run(request(await task(artifacts), cancel.signal))
  assert.equal(done.status, 'cancelled')
})

test('missing output fails despite a successful ACP turn', async () => {
  const { artifacts } = fixture()
  const runner: AcpRunner = {
    async run() { return { stopReason: 'end_turn', permissionDenied: false, events: [], exitCode: 0 } },
  }
  const done = await acpWorker(account(), artifacts, runner, join(root, 'missing')).run(request(await task(artifacts)))
  assert.equal(done.status, 'failed')
  assert.match(done.reason ?? '', /missing output/)
})

test('ACP transport failure never asserts a successful Worker result', async () => {
  const { artifacts } = fixture()
  const runner: AcpRunner = { async run() { throw new Error('protocol died') } }
  const done = await acpWorker(account(), artifacts, runner, join(root, 'failure')).run(request(await task(artifacts)))
  assert.equal(done.status, 'failed')
  assert.equal(done.outputs.report, undefined)
})
