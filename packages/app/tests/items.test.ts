import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildProgram, type Run } from '../src/cli.ts'
import type { HostClient } from '../src/remote.ts'
import { fakeHost } from './fake-host.ts'

async function system(args: string[], host: HostClient) {
  let out = ''
  let err = ''
  let run: Run | undefined
  const io = { out: (t: string) => { out += t }, err: (t: string) => { err += t }, confirmHuman: async () => 'tan' } as any
  const program = buildProgram(host, io, (r) => { run = r })
  program.exitOverride()
  await program.parseAsync(['node', 'system', ...args])
  const code = await run!()
  return { code, out, err }
}

function makeRepo(workflows: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-items-test-'))
  if (Object.keys(workflows).length) {
    mkdirSync(join(dir, 'workflows'), { recursive: true })
    for (const [name, content] of Object.entries(workflows)) writeFileSync(join(dir, 'workflows', name), content)
  }
  return dir
}

const workRecord = (id: string, repository: string, item: string, status: string, extra: { merged?: boolean; verdictId?: string; account?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; reason?: string } = {}) => ({
  id,
  events: [
    { type: 'admitted', seq: 0, at: '2026-11-28T00:00:00.000Z', caller: { type: 'agent', operatorId: 'tan' }, specId: 'sha256:spec', item: { id: item, repository }, source: { kind: 'workflow-file' } },
    ...(extra.account ? [{ type: 'dispatched', seq: 1, at: '2026-11-28T00:00:01.000Z', stepId: 'implement', attemptId: 'a1', executor: 'worker', capability: 'repo.write', selected: extra.account, candidates: [], inputs: {} }] : []),
    ...(extra.inputTokens !== undefined ? [{ type: 'observed', seq: 2, at: '2026-11-28T00:00:02.000Z', stepId: 'implement', attemptId: 'a1', status: 'succeeded', outputs: {}, usage: { state: 'observed', inputTokens: extra.inputTokens, outputTokens: extra.outputTokens ?? 0, ...(extra.costUsd !== undefined ? { costUsd: extra.costUsd } : {}), source: 'test' } }] : []),
    ...(extra.verdictId ? [{ type: 'verified', seq: 3, at: '2026-11-28T00:00:03.000Z', stepId: 'checks', attemptId: 'v1', subject: 'sha256:sub', criteria: 'sha256:crit', verdict: 'fail', reason: 'tests failed', verdictId: extra.verdictId }] : []),
  ],
  state: {
    status,
    specId: 'sha256:spec',
    reason: extra.reason,
    steps: {},
    results: {},
    effects: extra.merged ? { publish: { state: 'applied', detail: { merged: 'true', mergeCommit: 'abc1234' } } } : {},
  },
}) as any

test('sch-1: Ready Item claims, stores Task with status line, picks develop.yaml from install, submits, waits, prints JSON and exits 0 on merged', async () => {
  const repo = makeRepo()
  try {
    const calls: { method: string; params: unknown }[] = []
    const statusLine = '[ ] a-1 Build feature (intent: abc123def456) - todo: nobody'
    const host = fakeHost({
      status: (p) => { calls.push({ method: 'status', params: p }); return [statusLine, 'note: read dev'] },
      'work.list': (p) => { calls.push({ method: 'work.list', params: p }); return [] },
      'item.claim': (p) => { calls.push({ method: 'item.claim', params: p }); return { who: 'tan', at: '2026-11-28T00:00:00.000Z' } },
      'task.new': (p) => { calls.push({ method: 'task.new', params: p }); return { task: 'sha256:task1' } },
      'work.submit': (p) => { calls.push({ method: 'work.submit', params: p }); return { id: 'work:1' } },
    }, {
      run: async (workId) => workRecord(workId, repo, 'a-1', 'succeeded', { merged: true, account: 'claude/main', inputTokens: 100, outputTokens: 25, costUsd: 0.42 }),
    })
    const res = await system(['items', 'carry', 'a-1', '--repo', repo], host)
    assert.equal(res.code, 0, res.err)
    assert.deepEqual(calls.map((c) => c.method), ['status', 'work.list', 'item.claim', 'task.new', 'work.submit'])
    assert.deepEqual(calls[2]!.params, { repository: repo, item: 'a-1' })
    assert.deepEqual(calls[3]!.params, { instructions: `Carry out Item a-1 of STATUS.md: ${statusLine}`, repository: repo, item: 'a-1' })
    const submitted = calls[4]!.params as { workflow: string; input: string; run: boolean }
    assert.match(submitted.workflow, /id:\s*develop/)
    assert.equal(submitted.input, 'sha256:task1')
    assert.equal(submitted.run, false)
    assert.deepEqual(JSON.parse(res.out), {
      item: 'a-1',
      works: ['work:1'],
      outcome: 'merged',
      account: 'claude/main',
      tokens: 125,
      cost: 0.42,
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('sch-1: picks <name>.yaml from <repo>/workflows/ when present, else from install workflows/', async () => {
  const customWf = 'apiVersion: system.workflow/v1\nkind: Workflow\nname: custom-repo\nsteps:\n  - id: s\n    worker:\n      capabilities: [repo.write]\n'
  const repo = makeRepo({ 'research.yaml': customWf })
  try {
    const workflows: string[] = []
    const host = fakeHost({
      status: () => ['[ ] a-1 Investigate (workflow: research) - todo: nobody'],
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': () => ({ task: 'sha256:t' }),
      'work.submit': (p) => { workflows.push(p.workflow!); return { id: 'work:1' } },
    }, {
      run: async (id) => workRecord(id, repo, 'a-1', 'succeeded', { merged: true }),
    })
    const fromRepo = await system(['items', 'carry', 'a-1', '--repo', repo], host)
    assert.equal(fromRepo.code, 0)
    assert.equal(workflows[0], customWf)

    // Without repo override, hygiene.yaml comes from the install's workflows/
    const host2 = fakeHost({
      status: () => ['[ ] a-2 Clean (workflow: hygiene) - todo: nobody'],
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': () => ({ task: 'sha256:t' }),
      'work.submit': (p) => { workflows.push(p.workflow!); return { id: 'work:2' } },
    }, {
      run: async (id) => workRecord(id, repo, 'a-2', 'succeeded', { merged: true }),
    })
    const fromInstall = await system(['items', 'carry', 'a-2', '--repo', repo], host2)
    assert.equal(fromInstall.code, 0)
    assert.match(workflows[1]!, /id:\s*hygiene/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('sch-1: when first Work fails, submits one more Work with verdict Artifact in context; exits 0 if second merges, 1 if second fails', async () => {
  const repo = makeRepo()
  try {
    const tasks: unknown[] = []
    let n = 0
    const host = fakeHost({
      status: () => ['[ ] a-1 Fix bug - todo: nobody'],
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': (p) => { tasks.push(p); return { task: `sha256:task${tasks.length}` } },
      'work.submit': () => ({ id: `work:${++n}` }),
    }, {
      run: async (id) => id === 'work:1'
        ? workRecord(id, repo, 'a-1', 'failed', { verdictId: 'sha256:verdict1', account: 'claude/a', inputTokens: 50, outputTokens: 10, costUsd: 0.1 })
        : workRecord(id, repo, 'a-1', 'succeeded', { merged: true, account: 'codex/b', inputTokens: 80, outputTokens: 20, costUsd: 0.2 }),
    })
    const res = await system(['items', 'carry', 'a-1', '--repo', repo], host)
    assert.equal(res.code, 0)
    assert.equal(tasks.length, 2)
    assert.deepEqual((tasks[1] as { context?: string[] }).context, ['sha256:verdict1'])
    assert.deepEqual(JSON.parse(res.out), {
      item: 'a-1',
      works: ['work:1', 'work:2'],
      outcome: 'merged',
      account: 'codex/b',
      tokens: 160,
      cost: 0.30000000000000004,
    })

    // Both fail -> stops after 2, exits 1
    let m = 0
    const hostFail = fakeHost({
      status: () => ['[ ] a-1 Fix bug - todo: nobody'],
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': () => ({ task: 'sha256:t' }),
      'work.submit': () => ({ id: `work:${++m}` }),
    }, {
      run: async (id) => workRecord(id, repo, 'a-1', 'failed', { verdictId: `sha256:v${id}`, reason: 'still broken' }),
    })
    const resFail = await system(['items', 'carry', 'a-1', '--repo', repo], hostFail)
    assert.equal(resFail.code, 1)
    assert.equal(m, 2)
    assert.equal(JSON.parse(resFail.out).outcome, 'failed')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('sch-1: held Work exits 0 with outcome held', async () => {
  const repo = makeRepo()
  try {
    const host = fakeHost({
      status: () => ['[ ] a-1 Gate change - todo: nobody'],
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': () => ({ task: 'sha256:t' }),
      'work.submit': () => ({ id: 'work:1' }),
    }, {
      run: async (id) => workRecord(id, repo, 'a-1', 'held', { account: 'claude/a', reason: 'gate approval' }),
    })
    const res = await system(['items', 'carry', 'a-1', '--repo', repo], host)
    assert.equal(res.code, 0)
    assert.equal(JSON.parse(res.out).outcome, 'held')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('sch-1: skips Blocked, running/held Work, or >= 2 failed Works without claiming or submitting, saying why', async () => {
  const repo = makeRepo()
  try {
    const neverClaim = () => { throw new Error('must not claim') }
    const neverSubmit = () => { throw new Error('must not submit') }

    // Blocked
    const blocked = await system(['items', 'carry', 'a-2', '--repo', repo], fakeHost({
      status: () => ['[ ] a-2 Two - todo (blocked by a-1)'],
      'work.list': () => [],
      'item.claim': neverClaim,
      'work.submit': neverSubmit,
    }))
    assert.equal(blocked.code, 1)
    assert.match(blocked.err, /blocked by a-1/i)
    assert.equal(JSON.parse(blocked.out).outcome, 'skipped')

    // Running or held Work
    for (const status of ['running', 'held'] as const) {
      const busy = await system(['items', 'carry', 'a-2', '--repo', repo], fakeHost({
        status: () => [`[ ] a-2 Two - doing: work:busy step implement on claude since T`],
        'work.list': () => [{ id: 'work:busy', status, specId: 'sha256:s', item: 'a-2' }],
        'work.show': () => workRecord('work:busy', repo, 'a-2', status),
        'item.claim': neverClaim,
        'work.submit': neverSubmit,
      }))
      assert.equal(busy.code, 1)
      assert.match(busy.err, new RegExp(status))
      assert.equal(JSON.parse(busy.out).outcome, 'skipped')
    }

    // Two failed Works
    const twoFailed = await system(['items', 'carry', 'a-2', '--repo', repo], fakeHost({
      status: () => ['[ ] a-2 Two - todo: nobody'],
      'work.list': () => [
        { id: 'work:f1', status: 'failed', specId: 'sha256:s', item: 'a-2' },
        { id: 'work:f2', status: 'failed', specId: 'sha256:s', item: 'a-2' },
      ],
      'work.show': ({ workId }) => workRecord(workId, repo, 'a-2', 'failed'),
      'item.claim': neverClaim,
      'work.submit': neverSubmit,
    }))
    assert.equal(twoFailed.code, 1)
    assert.match(twoFailed.err, /two failed|2 failed/i)
    assert.equal(JSON.parse(twoFailed.out).outcome, 'skipped')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
