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

test('rel-2: release approve asks for the 7 hex of the commit, then stores the approval and prints its ID alone', async () => {
  const seen: unknown[] = []
  const prompts: string[] = []
  const result = await system(['release', 'approve', 'ABCDEF1234'], fakeHost({ 'release.approve': (params) => { seen.push(params); return { approval: 'sha256:appr' } } }), async (prompt, expected) => { prompts.push(expected); return 'tan' })
  assert.equal(result.out, 'sha256:appr\n')
  assert.deepEqual(prompts, ['abcdef1'])
  assert.deepEqual(seen, [{ commit: 'ABCDEF1234' }])
  await assert.rejects(system(['release', 'approve', 'main'], fakeHost({})), /7 to 40 hex/)
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
    { 'work.show': ({ workId }) => record(workId, 'failed', { specId: 'sha256:spec' }), 'artifact.show': () => specOf('checks'), 'work.verifyAgain': ({ step }) => { retried.push(`verifyAgain:${String(step)}`); return {} } },
    { retry: async ({ step }) => { retried.push(`retry:${String(step)}`); return 'detached' }, wait: async () => 'detached' },
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
  assert.deepEqual(retried, ['verifyAgain:checks'])
})

test('retry of a Worker step needs no confirmation', async () => {
  const { run, retried, confirmed } = await retry(['--step', 'implement'], false)
  await run()
  assert.equal(confirmed(), 0)
  assert.deepEqual(retried, ['retry:implement'])
})

test('work report --since with a date that has no zone says the UTC instant it uses, in the JSON and on stderr', async () => {
  const seen: unknown[] = []
  const host = fakeHost({ 'work.report': (params) => { seen.push(params); return { works: 0 } } })
  const day = await system(['work', 'report', '--since', '2026-11-18'], host)
  assert.equal(JSON.parse(day.out).sinceUtc, '2026-11-18T00:00:00.000Z')
  assert.match(day.err, /2026-11-18T00:00:00\.000Z/)
  assert.match(day.err, /UTC/)
  const time = await system(['work', 'report', '--since', '2026-11-18T10:30'], host)
  assert.equal(JSON.parse(time.out).sinceUtc, '2026-11-18T10:30:00.000Z')
  const zoned = await system(['work', 'report', '--since', '2026-11-18T10:30:00+02:00'], host)
  assert.equal(JSON.parse(zoned.out).sinceUtc, undefined)
  assert.equal(zoned.err, '')
  assert.deepEqual(seen[0], { since: '2026-11-18' })
})

const heldRecord = (id: string) => record(id, 'held', { awaiting: 'ship', reason: 'ship awaits operator approval: gate', steps: { ship: { outputs: {} } }, effects: {} })

test('work show of a held Work states the decision on stderr and keeps stdout the record JSON', async () => {
  const result = await system(['work', 'show', 'work:h'], fakeHost({ 'work.show': ({ workId }) => heldRecord(workId) }))
  assert.match(result.err, /^Decision needed\n/)
  assert.match(result.err, /system approve work:h/)
  assert.match(result.err, /system work retry work:h --step ship/)
  assert.doesNotMatch(result.out, /Decision needed/)
  assert.doesNotThrow(() => JSON.parse(result.out))
})

test('work show of a Work that is not held prints only the record JSON', async () => {
  const result = await system(['work', 'show', 'work:r'], fakeHost({ 'work.show': ({ workId }) => record(workId, 'running') }))
  assert.doesNotMatch(result.out, /Decision needed/)
  assert.doesNotThrow(() => JSON.parse(result.out))
})

test('approve prints the decision before asking for the typed confirmation', async () => {
  let printedBeforePrompt = ''
  let out = ''
  const host = fakeHost({ 'work.show': ({ workId }) => heldRecord(workId) }, { decide: async () => ({ state: { status: 'succeeded' } }) as any })
  const io = { out: (t: string) => { out += t }, err() {}, confirmHuman: async () => { printedBeforePrompt = out; return 'tan' } } as any
  let run: Run | undefined
  const program = buildProgram(host, io, (r) => { run = r })
  program.exitOverride()
  await program.parseAsync(['node', 'system', 'approve', 'work:h'])
  await run!()
  assert.match(printedBeforePrompt, /Decision needed[\s\S]*system deny work:h/)
})

for (const verb of ['approve', 'deny'] as const) {
  test(`gate-3: ${verb} prints what was recorded at once after the confirmation, then one line per event, never silent`, async () => {
    let out = ''
    const held = { ...heldRecord('work:h'), state: { ...heldRecord('work:h').state, effects: { op: { stepId: 'ship', state: 'failed', held: 'sha256:m', detail: { mergeCommit: '1c2e7cda5f3b9a8d7e6f' } } } } }
    const host = fakeHost({ 'work.show': () => held }, {
      decide: async (_params, _who, hooks) => {
        assert.equal(out.includes('following it'), false, 'nothing is said before the Host recorded the decision')
        hooks?.recorded?.()
        hooks?.onEvent?.({ seq: 9, type: 'decided', stepId: 'ship' })
        return { state: { status: 'succeeded' } } as any
      },
    })
    const io = { out: (t: string) => { out += t }, err() {}, confirmHuman: async () => 'tan' } as any
    let run: Run | undefined
    const program = buildProgram(host, io, (r) => { run = r })
    program.exitOverride()
    await program.parseAsync(['node', 'system', verb, 'work:h', '--reason', 'r'])
    await run!()
    const decision = verb === 'approve' ? 'approved' : 'denied'
    assert.match(out, new RegExp(`${decision} ship of work:h \\(commit 1c2e7cda5f3b\\); following it \\(Ctrl-C only detaches`))
    assert.match(out, /work:h #9 decided ship\n$/)
  })
}

test('the approve and deny prompt ends with the token alone, not the decision word', async () => {
  let prompt = ''
  const host = fakeHost({ 'work.show': ({ workId }) => heldRecord(workId) }, { decide: async () => ({ state: { status: 'failed' } }) as any })
  const io = { out() {}, err() {}, confirmHuman: async (p: string) => { prompt = p; return 'tan' } } as any
  let run: Run | undefined
  const program = buildProgram(host, io, (r) => { run = r })
  program.exitOverride()
  await program.parseAsync(['node', 'system', 'deny', 'work:abcdef0123', '--reason', 'no'])
  await run!()
  assert.match(prompt, /^To deny ship of work:abcdef0123, type the Work's short ID and press Enter, exactly: [0-9a-f]+\n> $/)
})

test('work trace prints the trace in order and --json prints the same as data; an empty log prints ID and size only', async () => {
  const sampleTrace = {
    id: 'work:t1',
    status: 'succeeded',
    specId: 'sha256:spec',
    admittedAt: '2026-11-28T00:00:00.000Z',
    timeline: [
      {
        kind: 'attempt',
        stepId: 'implement',
        attemptId: 'a1',
        account: 'claude-code/default',
        model: 'sonnet',
        startedAt: '2026-11-28T00:00:01.000Z',
        durationMs: 1200,
        status: 'succeeded',
        usage: { state: 'observed', inputTokens: 10, cacheReadTokens: 4, outputTokens: 2, source: 's' },
        log: { id: 'sha256:log1', size: 42 },
      },
      {
        kind: 'verdict',
        stepId: 'checks',
        attemptId: 'v1',
        at: '2026-11-28T00:00:03.000Z',
        verdict: 'fail',
        reason: 'unit failed',
        subject: 'sha256:sub1',
        failedChecks: [{ id: 'sha256:cr1', name: 'unit', run: 'pnpm test', commit: 'abc', exitCode: 1, signal: null, timedOut: false, stdoutTail: 'fail out', stderrTail: 'fail err' }],
      },
      { kind: 'terminal', at: '2026-11-28T00:00:04.000Z', outcome: 'failed', reason: 'unit failed', results: {} },
    ],
  }
  const host = fakeHost({ 'work.trace': () => sampleTrace })
  const text = await system(['work', 'trace', 'work:t1'], host)
  assert.match(text.out, /attempt implement \(a1\)/)
  assert.match(text.out, /log: sha256:log1 \(42 bytes\)/)
  assert.doesNotMatch(text.out, /commands:|files read:|files written:|final:/)
  assert.match(text.out, /failed check: unit \(sha256:cr1\)/)
  assert.match(text.out, /fail err/)
  assert.match(text.out, /outcome: failed/)
  const json = await system(['work', 'trace', 'work:t1', '--json'], host)
  assert.deepEqual(JSON.parse(json.out), sampleTrace)
})
