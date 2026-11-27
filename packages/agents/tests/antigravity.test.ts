/** The Antigravity Runtime (ag-2), from real outputs of `agy` 1.5.18 kept in fixtures/antigravity/: invocation, parse, limits, staging, quota. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { adapterFor } from '../src/adapters/index.ts'
import { processSpawner } from '../../../test-support/process.ts'
import { agentWorker, type Account } from '../src/agent.ts'
import { readAntigravityQuota } from '../src/quota.ts'
import { isQuotaLimited, quotaResetFrom } from '../../work/src/limits.ts'
import { GIT_TREE_KIND, TASK_KIND, gitTreeSchema, snapshot, taskSchema, type WorkerRequest } from '@system/work'

const dir = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => readFileSync(join(dir, 'fixtures', 'antigravity', name), 'utf8')
const fake = join(dir, 'fake-agent.mjs')
const root = mkdtempSync(join(tmpdir(), 'system-agy-'))
after(() => rmSync(root, { recursive: true, force: true }))
const adapter = adapterFor('antigravity')!
const SETTINGS = { permissions: { allow: ['command(*)'], deny: ['command(git push)', 'command(gh)'] } }
const ws = { root: '/ws', home: '/ws/home', inputs: '/ws/in', outputs: '/ws/out', work: '/ws/work' } as never
const account = (extra: Partial<Account> = {}): Account => ({ ref: 'antigravity/a1', runtime: 'antigravity', capabilities: ['repo.write'], command: fake, version: async () => 'fake', ...extra })

const EXPECTED_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    reason: { type: 'string' },
  },
  required: ['status', 'reason'],
  additionalProperties: false,
}

test('parse: a structured done result is ok with its reason and the token counts of its turn', () => {
  const parsed = adapter.parse(fixture('stream-done.jsonl'))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.message, 'implemented the change')
  assert.deepEqual(parsed.finalResult, { status: 'done', reason: 'implemented the change' })
  assert.equal(parsed.usage?.inputTokens, 1400)
  assert.equal(parsed.usage?.outputTokens, 18)
  assert.equal(parsed.usage?.cacheReadTokens, 200)
  assert.match(parsed.usage!.source, /antigravity/)
})

test('parse: a structured blocked result fails with the Worker own reason and keeps finalResult', () => {
  const parsed = adapter.parse(fixture('stream-blocked.jsonl'))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.message, 'missing required context artifact')
  assert.deepEqual(parsed.finalResult, { status: 'blocked', reason: 'missing required context artifact' })
  assert.equal(parsed.usage?.inputTokens, 900)
})

test('parse: a SUCCESS result without the structured final result fails naming it, while keeping usage', () => {
  for (const name of ['stream-ok.jsonl', 'stream-tools-sandbox-deny.jsonl']) {
    const parsed = adapter.parse(fixture(name))
    assert.equal(parsed.ok, false)
    assert.match(parsed.message, /structured final result/i)
    assert.ok(parsed.usage && parsed.usage.inputTokens > 0)
  }
})

test('parse: agy 1.5.18 puts the structured result in the last agent_response step, the result response is prose (work:85c3d99f)', () => {
  const parsed = adapter.parse(fixture('stream-structured-in-step.jsonl'))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.finalResult?.status, 'done')
  assert.match(parsed.finalResult!.reason, /^Applied the exact diff from context-1/)
  assert.equal(parsed.message, parsed.finalResult!.reason)
})

test('parse: structured text streamed in several deltas of the last agent_response step is joined; a blocked one fails with its reason', () => {
  const step = (state: string, text: string) => JSON.stringify({ step_update: { step_index: 3, state, step_type: 'agent_response', text_delta: text } })
  const stream = [
    JSON.stringify({ step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'prose first' } }),
    step('ACTIVE', '{"reason":"no ac'), step('DONE', 'cess","status":"blocked"}'),
    JSON.stringify({ step_update: { step_index: 4, state: 'DONE', step_type: 'finish' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'a prose summary' } }),
  ].join('\n')
  const parsed = adapter.parse(stream)
  assert.equal(parsed.ok, false)
  assert.deepEqual(parsed.finalResult, { status: 'blocked', reason: 'no access' })
  assert.equal(parsed.message, 'no access')
})

test('parse: prose in the last agent_response step and in the result response fails naming the structured result', () => {
  const stream = [
    JSON.stringify({ step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'just prose' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'also prose' } }),
  ].join('\n')
  const parsed = adapter.parse(stream)
  assert.equal(parsed.ok, false)
  assert.match(parsed.message, /structured final result/)
})

test('parse: a run that ended with denied actions and no response fails naming them, not as an empty success', () => {
  const parsed = adapter.parse(fixture('stream-denied-read.jsonl'))
  assert.equal(parsed.ok, false)
  assert.match(parsed.message, /read_file/)
  assert.match(parsed.message, /headless/)
})

test('parse: denied actions with a structured done response are only noted, the run stays ok', () => {
  const line = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify({ status: 'done', reason: 'done' }), denied_actions: [{ action: 'read_file' }] } })
  const parsed = adapter.parse(line)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.message, 'done')
  assert.deepEqual(parsed.finalResult, { status: 'done', reason: 'done' })
})

test('parse: an ERROR result fails with its text; a quota or 429 error is one the controller records as limited, with its reset', () => {
  const result = (error: string) => JSON.stringify({ event: 'result', result: { status: 'ERROR', error } })
  assert.deepEqual([adapter.parse(result('boom')).ok, adapter.parse(result('boom')).message], [false, 'boom'])
  const reset = '2026-11-27T03:00:00Z'
  for (const error of [`RESOURCE_EXHAUSTED: quota will reset after ${reset}`, 'HTTP 429 Too Many Requests', 'You have exhausted your capacity on this model.']) {
    const parsed = adapter.parse(result(error))
    assert.equal(parsed.ok, false)
    assert.ok(isQuotaLimited(parsed.message), parsed.message)
  }
  assert.equal(quotaResetFrom(adapter.parse(result(`RESOURCE_EXHAUSTED: resets ${reset}`)).message, Date.parse('2026-11-26T00:00:00Z')), Date.parse(reset))
  assert.equal(isQuotaLimited(adapter.parse(result('Eligibility check failed')).message), false)
  assert.equal(adapter.parse('not json').ok, false)
})

test('the argv is accept-edits in the sandbox, adds the inputs and outputs directories, passes --json-schema, and never skips permissions', () => {
  const { argv, env } = adapter.invocation({ command: 'agy', ws, prompt: 'do it', model: 'gemini-3.8-flash-low', codeWrite: true, env: {} })
  const schemaIndex = argv.indexOf('--json-schema')
  assert.ok(schemaIndex >= 0, 'passes --json-schema')
  assert.deepEqual(JSON.parse(argv[schemaIndex + 1]!), EXPECTED_SCHEMA)
  assert.deepEqual(argv.slice(0, schemaIndex), ['agy', '-p', 'do it', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash-low', '--mode', 'accept-edits', '--sandbox', '--add-dir', '/ws/in', '--add-dir', '/ws/out'])
  assert.equal(argv.includes('--dangerously-skip-permissions'), false)
  assert.equal(argv.includes('auto'), false)
  assert.equal(env.HOME, '/ws/home')
  assert.equal('DBUS_SESSION_BUS_ADDRESS' in env, false)
  assert.deepEqual(adapter.invocation({ command: 'agy', ws, prompt: 'do it', model: 'gemini-3.8-flash-low', codeWrite: true, env: {}, sandbox: true }).argv, argv, 'the layer wraps the process, it changes no flag')
})

test('the recorded scope is the mode and sandbox of the argv and the sha256 of the staged settings bytes', async () => {
  const { argv, scope } = adapter.invocation({ command: 'agy', ws, prompt: 'p', codeWrite: false, env: {} })
  const home = join(root, 'scope-home')
  const pre = await adapter.preflight(account({ agyHome: home }))
  assert.ok('stage' in pre)
  pre.stage(join(root, 'attempt'))
  const bytes = readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'))
  assert.deepEqual(scope, { permissionMode: argv[argv.indexOf('--mode') + 1], sandbox: argv.includes('--sandbox'), settingsSha256: createHash('sha256').update(bytes).digest('hex') })
})

test('preflight needs an agyHome; staging writes the settings file and links .gemini into the attempt home, idempotently', async () => {
  assert.deepEqual(await adapter.preflight(account()), { failed: 'antigravity/a1: no agyHome (the Account home holding .gemini/antigravity-cli)' })
  const home = join(root, 'new-home', 'a1')
  const pre = await adapter.preflight(account({ agyHome: home }))
  assert.ok('stage' in pre)
  const file = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  const attemptDir = join(root, 'attempt')
  const linked = join(attemptDir, 'home', '.gemini')
  for (const _ of [1, 2]) {
    const staged = pre.stage(attemptDir)
    assert.deepEqual(staged.env, {})
    assert.ok(lstatSync(linked).isSymbolicLink())
    assert.equal(readFileSync(file, 'utf8'), fixture('settings.json'))
    assert.equal(readFileSync(join(linked, 'antigravity-cli', 'settings.json'), 'utf8'), fixture('settings.json'))
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), SETTINGS)
  }
  assert.deepEqual(JSON.parse(fixture('settings.json')), SETTINGS)
})

test('the usage reading: Gemini and Claude-and-GPT groups from one answer; a reset of 1970 is unknown, not past', async () => {
  const run = async (answerFile: string, quotaGroup: 'gemini' | '3p') => {
    const bin = join(root, `agy-usage-${Math.random().toString(16).slice(2)}`)
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > "$0.argv"\nprintf 'HOME=%s DBUS=%s\\n' "$HOME" "\${DBUS_SESSION_BUS_ADDRESS-unset}" > "$0.env"\ncat ${JSON.stringify(join(dir, 'fixtures', 'antigravity', answerFile))} | tr -d '\\n'; echo\n`)
    chmodSync(bin, 0o700)
    const home = join(root, 'usage-home')
    mkdirSync(home, { recursive: true })
    const report = await readAntigravityQuota({ command: bin, home, group: quotaGroup, now: () => Date.parse('2026-11-26T10:00:00Z') })
    return { report, argv: readFileSync(`${bin}.argv`, 'utf8').trim(), env: readFileSync(`${bin}.env`, 'utf8').trim(), home }
  }
  const a1 = await run('usage-a1.json', 'gemini')
  assert.equal(a1.argv, '-p /usage --output-format json --print-timeout 30s')
  assert.equal(a1.env, `HOME=${a1.home} DBUS=unset`)
  assert.deepEqual(a1.report, { observedAt: '2026-11-26T10:00:00.000Z', windows: { five_hour: { percentUsed: 0, resetsAt: '2026-11-26T14:53:18.000Z' }, seven_day: { percentUsed: 0, resetsAt: '2026-12-03T09:53:18.000Z' } } })
  assert.deepEqual((await run('usage-a1.json', '3p')).report, a1.report)
  const a2 = await run('usage-a2-3p-1970.json', '3p')
  assert.deepEqual(a2.report, { observedAt: '2026-11-26T10:00:00.000Z', windows: { five_hour: { percentUsed: 0 }, seven_day: { percentUsed: 0 } } })
  const gemini = await run('usage-a2-3p-1970.json', 'gemini')
  assert.equal((gemini.report as { windows: { five_hour: { resetsAt: string } } }).windows.five_hour.resetsAt, '2026-11-26T14:53:24.000Z')
})

test('the usage reading shows used share, refuses a malformed answer and a missing group, and names an ERROR result', async () => {
  const answer = JSON.parse(fixture('usage-a1.json')) as { command: { data: { groups: Array<{ buckets: Array<Record<string, unknown>> }> } } }
  const cli = (body: unknown) => {
    const bin = join(root, `agy-q-${Math.random().toString(16).slice(2)}`)
    writeFileSync(`${bin}.json`, `${JSON.stringify(body)}\n`)
    writeFileSync(bin, `#!/bin/sh\ncat ${JSON.stringify(`${bin}.json`)}\n`)
    chmodSync(bin, 0o700)
    return bin
  }
  const home = join(root, 'usage-home')
  mkdirSync(home, { recursive: true })
  const read = (body: unknown, group: 'gemini' | '3p' = 'gemini') => readAntigravityQuota({ command: cli(body), home, group, now: () => Date.parse('2026-11-26T10:00:00Z') })
  answer.command.data.groups[0]!.buckets[0]!.remaining_fraction = 0.25
  const used = await read(answer)
  assert.ok('windows' in used, JSON.stringify(used))
  assert.equal(used.windows.seven_day?.percentUsed, 75)
  answer.command.data.groups[0]!.buckets[0]!.remaining_fraction = 1.5
  assert.match(String((await read(answer) as { unreadable: string }).unreadable), /does not match the checked schema/)
  assert.match(String((await read({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } }) as { unreadable: string }).unreadable), /Gemini Models/)
  const failed = await read({ status: 'ERROR', error: 'Eligibility check failed: not eligible' })
  assert.match(String((failed as { unreadable: string }).unreadable), /Eligibility check failed/)
})

test('the argv of a real attempt: env has throwaway HOME with only .gemini linked and no DBUS_SESSION_BUS_ADDRESS, and two attempts do not see each other HOME files', async () => {
  const repository = mkdtempSync(join(root, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(repository, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...GIT_TREE_KIND, content: gitTreeSchema })
  const producer = { type: 'operator' as const, ref: 'tester' }
  const tree = (await artifacts.put({ ...GIT_TREE_KIND, content: await snapshot(repository), classification: 'local-private', producer })).id
  const makeTask = async (marker: string) => (await artifacts.put({ ...TASK_KIND, content: { instructions: `FAKE:edit FAKE:env FAKE:home=${marker} FAKE:delay=300`, base: tree }, inputs: [tree], classification: 'local-private', producer })).id
  const request = (task: string): WorkerRequest => ({ workId: 'work:test', attemptId: `attempt:${Math.random().toString(16).slice(2)}`, stepId: 'implement', capabilities: ['repo.write'], inputs: { task }, outputs: ['change'], signal: new AbortController().signal })
  const home = join(root, 'shared-agy-home')
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'tok\n')
  writeFileSync(join(home, 'outside-gemini.txt'), 'not-reachable\n')
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus'
  try {
    const names = ['a1', 'a2'] as const
    const workers = names.map((n) => agentWorker(account({ ref: `antigravity/${n}`, agyHome: home, models: { standard: 'gemini-3.8-flash-low' } }), artifacts, processSpawner, join(root, `attempts-${n}`)))
    const tasks = await Promise.all(names.map((n) => makeTask(`from-${n}.txt`)))
    const results = await Promise.all(workers.map((w, i) => w.run(request(tasks[i]!))))
    const seenHomes: string[] = []
    for (const result of results) {
      assert.equal(result.status, 'succeeded', result.reason)
      assert.deepEqual(result.finalResult, { status: 'done', reason: 'done' })
      assert.deepEqual(result.usage, { inputTokens: 140, cacheReadTokens: 40, outputTokens: 7, source: result.usage!.source })
      const commit = (artifacts.get(result.outputs.change!) as { envelope: { content: { commit: string } } }).envelope.content.commit
      const seen = JSON.parse(execFileSync('git', ['-C', repository, 'show', `${commit}:ENV.json`], { encoding: 'utf8' })) as { home: string; dbus?: string; keys: string[]; model: string; homeFilesBefore: string[] }
      assert.notEqual(seen.home, home)
      assert.deepEqual(seen.homeFilesBefore, ['.gemini'])
      assert.equal(seen.dbus, undefined)
      assert.equal(seen.model, 'gemini-3.8-flash-low')
      seenHomes.push(seen.home)
    }
    assert.notEqual(seenHomes[0], seenHomes[1])
    // A subsequent attempt on the same agyHome also starts with only .gemini in HOME.
    const seqResult = await workers[0]!.run(request(await makeTask('from-a3.txt')))
    assert.equal(seqResult.status, 'succeeded', seqResult.reason)
    const seqCommit = (artifacts.get(seqResult.outputs.change!) as { envelope: { content: { commit: string } } }).envelope.content.commit
    const seqSeen = JSON.parse(execFileSync('git', ['-C', repository, 'show', `${seqCommit}:ENV.json`], { encoding: 'utf8' })) as { home: string; homeFilesBefore: string[] }
    assert.deepEqual(seqSeen.homeFilesBefore, ['.gemini'])
    // Cleanup of attempts did not delete the Account's .gemini state or write attempt files into agyHome.
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')), SETTINGS)
    assert.equal(existsSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')), true)
    assert.deepEqual(readdirSync(home).sort(), ['.gemini', 'outside-gemini.txt'])
  } finally {
    delete process.env.DBUS_SESSION_BUS_ADDRESS
  }
})

test('antigravity blocked result fails the attempt with the Worker own reason (never no-change or missing output) and keeps finalResult', async () => {
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...GIT_TREE_KIND, content: gitTreeSchema })
  const producer = { type: 'operator' as const, ref: 'tester' }
  const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'FAKE:blocked=missing context artifact ID' }, classification: 'local-private', producer })).id
  const request: WorkerRequest = { workId: 'work:test', attemptId: 'attempt:agy-blocked', stepId: 'implement', capabilities: [], inputs: { task }, outputs: ['report'], signal: new AbortController().signal }
  const home = join(root, 'blocked-agy-home')
  const result = await agentWorker(account({ agyHome: home }), artifacts, processSpawner, join(root, 'attempts-blocked')).run(request)
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /missing context artifact ID/)
  assert.equal(/no change|wrote no output/i.test(result.reason!), false)
  assert.deepEqual(result.finalResult, { status: 'blocked', reason: 'missing context artifact ID' })
})
