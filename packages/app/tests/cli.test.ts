import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildProgram, type Run } from '../src/cli.ts'
import type { HostClient } from '../src/remote.ts'
import { fakeHost } from './fake-host.ts'

const record = (id: string, status: string, extra: object = {}) => ({ id, events: [], state: { status, ...extra } }) as any

/** Run `system ...args` against a fake Host; returns the exit code, stdout and stderr. */
async function system(args: string[], host: HostClient, confirm: (prompt: string, expected: string) => Promise<string> = async () => 'tan') {
  let out = ''
  let err = ''
  let run: Run | undefined
  const io = { out: (t: string) => { out += t }, err: (t: string) => { err += t }, confirmHuman: confirm } as any
  const program = buildProgram(host, io, (r) => { run = r })
  program.exitOverride()
  await program.parseAsync(['node', 'system', ...args])
  const code = await run!()
  return { code, out, err }
}

test('task new prints the Task ID alone on stdout, and the base commit on stderr', async () => {
  const result = await system(['task', 'new', '--text', 'x', '--repo', '.'], fakeHost({ 'task.new': () => ({ task: 'sha256:task', base: 'sha256:base' }) }))
  assert.equal(result.out, 'sha256:task\n')
  assert.match(result.err, /base sha256:base/)
})

test('intent new prints the Intent ID alone and needs exactly one of --body and --body-file', async () => {
  const seen: unknown[] = []
  const host = fakeHost({ 'intent.new': (params) => { seen.push(params); return { intent: 'sha256:intent' } } })
  const result = await system(['intent', 'new', '--title', 'T', '--body', 'B', '--supersedes', 'sha256:old'], host)
  assert.equal(result.out, 'sha256:intent\n')
  assert.deepEqual(seen, [{ title: 'T', body: 'B', supersedes: 'sha256:old' }])
  await system(['intent', 'new', '--title', 'T', '--body', 'B', '--settled-by-operator'], host)
  assert.deepEqual(seen[1], { title: 'T', body: 'B', settledByOperator: true })
  await assert.rejects(system(['intent', 'new', '--title', 'T'], host), /exactly one of --body and --body-file/)
})

test('defect add prints the Artifact ID alone', async () => {
  const seen: unknown[] = []
  const host = fakeHost({ 'defect.add': (params) => { seen.push(params); return { defect: 'sha256:defect' } } })
  const result = await system(['defect', 'add', 'ms-1', '--found-by', 'work:x', '--reason', 'broke'], host)
  assert.equal(result.out, 'sha256:defect\n')
  assert.deepEqual(seen, [{ subject: 'ms-1', foundBy: 'work:x', reason: 'broke' }])
  seen.length = 0
  await system(['defect', 'add', 'ms-1', '--found-by', 'work:x', '--reason', 'broke', '--supersedes', 'sha256:old'], host)
  assert.deepEqual(seen, [{ subject: 'ms-1', foundBy: 'work:x', reason: 'broke', supersedes: 'sha256:old' }])
})

test('defect withdraw prints the Artifact ID alone', async () => {
  const seen: unknown[] = []
  const result = await system(['defect', 'withdraw', 'sha256:d', '--reason', 'wrong carrier'], fakeHost({ 'defect.withdraw': (params) => { seen.push(params); return { withdrawal: 'sha256:w' } } }))
  assert.equal(result.out, 'sha256:w\n')
  assert.deepEqual(seen, [{ withdraws: 'sha256:d', reason: 'wrong carrier' }])
})

test('confirm prints the Artifact ID alone', async () => {
  const seen: unknown[] = []
  const result = await system(['confirm', 'sha256:subject', '--note', 'checked'], fakeHost({ 'artifact.confirm': (params) => { seen.push(params); return { confirmation: 'sha256:conf' } } }))
  assert.equal(result.out, 'sha256:conf\n')
  assert.deepEqual(seen, [{ subject: 'sha256:subject', note: 'checked' }])
})

for (const verb of ['approve', 'deny'] as const) {
  test(`${verb} several Works asks for one typed confirmation and decides each`, async () => {
    const decided: string[] = []
    const asked: { prompt: string; expected: string }[] = []
    const host = fakeHost(
      { 'work.show': ({ workId }) => record(workId, 'held', { reason: 'awaiting', awaiting: 'publish' }) },
      { decide: async ({ workId, decision }, who) => { decided.push(`${workId} ${decision} ${who}`); return record(workId, decision === 'approved' ? 'succeeded' : 'failed') } },
    )
    const result = await system([verb, 'work:aaaaaaaa1', 'work:bbbbbbbb2', 'work:cccccccc3', '--reason', 'tidy'], host, async (prompt, expected) => { asked.push({ prompt, expected }); return 'tan' })
    assert.equal(asked.length, 1, 'one confirmation for all')
    assert.equal(asked[0]!.expected, `${verb} 3`)
    for (const id of ['work:aaaaaaaa1', 'work:bbbbbbbb2', 'work:cccccccc3']) assert.ok(asked[0]!.prompt.includes(id) || result.out.includes(id), id)
    const decision = verb === 'approve' ? 'approved' : 'denied'
    assert.deepEqual(decided, ['work:aaaaaaaa1', 'work:bbbbbbbb2', 'work:cccccccc3'].map((id) => `${id} ${decision} tan`))
    assert.equal(result.code, verb === 'approve' ? 0 : 1)
  })
}

test('deciding several Works refuses them all, deciding none, when one does not exist', async () => {
  const decided: string[] = []
  const host = fakeHost(
    { 'work.show': ({ workId }) => (workId === 'work:missing' ? undefined : record(workId, 'held')) },
    { decide: async ({ workId }) => { decided.push(workId); return record(workId, 'failed') } },
  )
  await assert.rejects(system(['deny', 'work:a', 'work:missing', '--reason', 'x'], host), /no Work work:missing/)
  assert.deepEqual(decided, [])
})

test('claim records a claim on an Item of the repository', async () => {
  const seen: unknown[] = []
  const result = await system(['claim', 'df-24', '--repo', '/r', '--force'], fakeHost({ 'item.claim': (params) => { seen.push(params); return { who: 'tan', at: 'T' } } }))
  assert.deepEqual(seen, [{ repository: '/r', item: 'df-24', force: true }])
  assert.match(result.out, /df-24 claimed by tan/)
})

const specOf = (verifyId: string) => ({ state: 'stored', envelope: { content: { steps: [{ id: 'implement', worker: {} }, { id: verifyId, verify: { capability: 'checks' } }] } } })

/** A fake Host for `work retry`: the spec has a verify step `checks`; `retried` collects the steps run again. */
function retryHost(retried: string[]): HostClient {
  return fakeHost(
    { 'work.show': ({ workId }) => record(workId, 'failed', { specId: 'sha256:spec' }), 'artifact.show': () => specOf('checks') },
    { retry: async ({ step }) => { retried.push(String(step)); return 'detached' } },
  )
}

async function retry(args: string[], terminal: boolean) {
  const retried: string[] = []
  let confirmed = 0
  const io = { out() {}, err() {}, confirmHuman: async (_p: string, _e: string) => { if (!terminal) throw new Error('this decision needs a human at a terminal'); confirmed++; return 'tan' } } as any
  let run: Run | undefined
  const program = buildProgram(retryHost(retried), io, (r) => { run = r })
  program.exitOverride()
  await program.parseAsync(['node', 'system', 'work', 'retry', 'work:a', ...args])
  return { run: run!, retried, confirmed: () => confirmed }
}

test('retry of a verify step without a terminal is refused, and run nothing', async () => {
  const { run, retried } = await retry(['--step', 'checks'], false)
  await assert.rejects(run(), /needs a human at a terminal/)
  assert.deepEqual(retried, [])
})

test('retry of a verify step asks the typed confirmation of a human, then retries', async () => {
  const { run, retried, confirmed } = await retry(['--step', 'checks'], true)
  await run()
  assert.equal(confirmed(), 1)
  assert.deepEqual(retried, ['checks'])
})

test('retry of a Worker step needs no confirmation', async () => {
  const { run, retried, confirmed } = await retry(['--step', 'implement'], false)
  await run()
  assert.equal(confirmed(), 0)
  assert.deepEqual(retried, ['implement'])
})
