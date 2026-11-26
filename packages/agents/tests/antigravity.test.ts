/** The Antigravity Runtime (ag-2), from real outputs of `agy` 1.5.18 kept in fixtures/antigravity/: invocation, parse, limits, staging, quota. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('parse: a plain answer is ok with its message and the token counts of its one turn', () => {
  const parsed = adapter.parse(fixture('stream-ok.jsonl'))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.message.trim(), 'OK')
  assert.equal(parsed.usage?.inputTokens, 10400)
  assert.equal(parsed.usage?.outputTokens, 1)
  assert.equal(parsed.usage?.cacheReadTokens, 0)
  assert.match(parsed.usage!.source, /antigravity/)
})

test('parse: a tool that ends in ERROR (git push denied by a rule) does not fail the attempt by itself', () => {
  const parsed = adapter.parse(fixture('stream-tools-sandbox-deny.jsonl'))
  assert.equal(parsed.ok, true)
  assert.match(parsed.message, /Permission denied/)
  assert.ok(parsed.usage && parsed.usage.inputTokens > 0)
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

test('the argv is accept-edits in the sandbox, adds the outputs directory, and never skips permissions', () => {
  const { argv, env } = adapter.invocation({ command: 'agy', ws, prompt: 'do it', model: 'gemini-3.8-flash-low', codeWrite: true, env: { HOME: '/homes/a1' } })
  assert.deepEqual(argv, ['agy', '-p', 'do it', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash-low', '--mode', 'accept-edits', '--sandbox', '--add-dir', '/ws/out'])
  assert.equal(argv.includes('--dangerously-skip-permissions'), false)
  assert.equal(argv.includes('auto'), false)
  assert.equal(env.HOME, '/homes/a1')
  assert.equal('DBUS_SESSION_BUS_ADDRESS' in env, false)
  assert.throws(() => adapter.invocation({ command: 'agy', ws, prompt: 'p', codeWrite: false, env: {}, sandbox: true }), /sandbox/)
})

test('preflight needs an agyHome; staging writes the settings file with exactly the allow and deny rules, idempotently', async () => {
  assert.deepEqual(await adapter.preflight(account()), { failed: 'antigravity/a1: no agyHome (the Account home holding .gemini/antigravity-cli)' })
  const home = join(root, 'new-home', 'a1')
  const pre = await adapter.preflight(account({ agyHome: home }))
  assert.ok('stage' in pre)
  const file = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  for (const _ of [1, 2]) {
    const staged = pre.stage(join(root, 'attempt'))
    assert.deepEqual(staged.env, { HOME: home })
    assert.equal(readFileSync(file, 'utf8'), fixture('settings.json'))
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

test('the argv of a real attempt: env has HOME = the Account home and no DBUS_SESSION_BUS_ADDRESS, and two attempts of two Accounts sharing one home both succeed', async () => {
  const repository = mkdtempSync(join(root, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(repository, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...GIT_TREE_KIND, content: gitTreeSchema })
  const producer = { type: 'operator' as const, ref: 'tester' }
  const tree = (await artifacts.put({ ...GIT_TREE_KIND, content: await snapshot(repository), classification: 'local-private', producer })).id
  const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'FAKE:edit FAKE:env FAKE:delay=300', base: tree }, inputs: [tree], classification: 'local-private', producer })).id
  const request = (): WorkerRequest => ({ workId: 'work:test', attemptId: `attempt:${Math.random().toString(16).slice(2)}`, stepId: 'implement', capabilities: ['repo.write'], inputs: { task }, outputs: ['change'], signal: new AbortController().signal })
  const home = join(root, 'shared-agy-home')
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus'
  try {
    const workers = ['a1', 'a2'].map((n) => agentWorker(account({ ref: `antigravity/${n}`, agyHome: home, models: { standard: 'gemini-3.8-flash-low' } }), artifacts, processSpawner, join(root, `attempts-${n}`)))
    const results = await Promise.all(workers.map((w) => w.run(request())))
    for (const result of results) {
      assert.equal(result.status, 'succeeded', result.reason)
      assert.deepEqual(result.usage, { inputTokens: 140, cacheReadTokens: 40, outputTokens: 7, source: result.usage!.source })
      const commit = (artifacts.get(result.outputs.change!) as { envelope: { content: { commit: string } } }).envelope.content.commit
      const seen = JSON.parse(execFileSync('git', ['-C', repository, 'show', `${commit}:ENV.json`], { encoding: 'utf8' })) as { home: string; dbus?: string; keys: string[]; model: string }
      assert.equal(seen.home, home)
      assert.equal(seen.dbus, undefined)
      assert.equal(seen.model, 'gemini-3.8-flash-low')
    }
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')), SETTINGS)
  } finally {
    delete process.env.DBUS_SESSION_BUS_ADDRESS
  }
})
