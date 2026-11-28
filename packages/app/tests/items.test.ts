import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { NotAnswering, NotRunning } from '@system/host'
import { buildProgram, type Run } from '../src/cli.ts'
import type { HostClient } from '../src/remote.ts'
import { fakeHost } from './fake-host.ts'

async function system(args: string[], host: HostClient, home?: string) {
  let out = ''
  let err = ''
  let run: Run | undefined
  const io = { out: (t: string) => { out += t }, err: (t: string) => { err += t }, confirmHuman: async () => 'tan' } as any
  const program = buildProgram(host, io, (r) => { run = r }, home)
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

const workRecord = (id: string, repository: string, item: string, status: string, extra: { merged?: boolean; verdictId?: string; account?: string; inputTokens?: number; cacheReadTokens?: number; outputTokens?: number; costUsd?: number; reason?: string } = {}) => ({
  id,
  events: [
    { type: 'admitted', seq: 0, at: '2026-11-28T00:00:00.000Z', caller: { type: 'agent', operatorId: 'tan' }, specId: 'sha256:spec', item: { id: item, repository }, source: { kind: 'workflow-file' } },
    ...(extra.account ? [{ type: 'dispatched', seq: 1, at: '2026-11-28T00:00:01.000Z', stepId: 'implement', attemptId: 'a1', executor: 'worker', capability: 'repo.write', selected: extra.account, candidates: [], inputs: {} }] : []),
    ...(extra.inputTokens !== undefined ? [{ type: 'observed', seq: 2, at: '2026-11-28T00:00:02.000Z', stepId: 'implement', attemptId: 'a1', status: 'succeeded', outputs: {}, usage: { state: 'observed', inputTokens: extra.inputTokens, ...(extra.cacheReadTokens !== undefined ? { cacheReadTokens: extra.cacheReadTokens } : {}), outputTokens: extra.outputTokens ?? 0, ...(extra.costUsd !== undefined ? { costUsd: extra.costUsd } : {}), source: 'test' } }] : []),
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

test('sch-2: pass reads repos in order, carries Ready Items, and picks up Items unblocked by a merge', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repoA = makeRepo()
  const repoB = makeRepo()
  try {
    const merged = new Set<string>()
    const started: string[] = []
    const statusOrder: string[] = []
    let workSeq = 0
    const workMeta = new Map<string, { repo: string; item: string }>()
    const stored: { mediaType?: string; body: string }[] = []
    const host = fakeHost({
      status: ({ repository }) => {
        statusOrder.push(repository)
        if (repository === repoA) {
          return [
            merged.has('a-1') ? '[x] a-1 First A - done; last work:1' : '[ ] a-1 First A - todo: nobody',
            merged.has('a-2') ? '[x] a-2 Second A - done; last work:2' : merged.has('a-1') ? '[ ] a-2 Second A - todo: nobody' : '[ ] a-2 Second A - todo (blocked by a-1)',
          ]
        }
        return [
          merged.has('b-1') ? '[x] b-1 First B - done; last work:3' : '[ ] b-1 First B - todo: nobody',
        ]
      },
      'workers.list': () => ({ registered: ['claude/a'], accounts: [], room: { accounts: 1, free: 1, unknown: [], ready: [] } }),
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': (p) => {
        started.push(`${p.repository === repoA ? 'A' : 'B'}:${p.item}`)
        return { task: `sha256:t${started.length}` }
      },
      'work.submit': () => {
        const id = `work:${++workSeq}`
        const last = started.at(-1)!
        const [tag, item] = last.split(':') as [string, string]
        workMeta.set(id, { repo: tag === 'A' ? repoA : repoB, item })
        return { id }
      },
      'artifact.put': (p) => {
        stored.push({ mediaType: p.mediaType, body: Buffer.from(p.data, 'base64').toString('utf8') })
        return { id: 'sha256:report-pass' }
      },
    }, {
      run: async (id) => {
        const meta = workMeta.get(id)!
        merged.add(meta.item)
        return workRecord(id, meta.repo, meta.item, 'succeeded', { merged: true, account: 'claude/a' })
      },
    })

    const res = await system(['items', 'carry', '--repo', repoA, '--repo', repoB], host, home)
    assert.equal(res.code, 0, res.err)
    // First cycle reads repoA then repoB in order
    assert.deepEqual(statusOrder.slice(0, 2), [repoA, repoB])
    // With 1 free Account: a-1 runs and merges -> unblocks a-2 in repoA, which precedes repoB's b-1
    assert.deepEqual(started, ['A:a-1', 'A:a-2', 'B:b-1'])
    assert.equal(res.out.trim(), 'sha256:report-pass')
    assert.equal(stored.length, 1)
    assert.match(stored[0]!.body, /\| a-1 \|.*\| merged \|/)
    assert.match(stored[0]!.body, /\| a-2 \|.*\| merged \|/)
    assert.match(stored[0]!.body, /\| b-1 \|.*\| merged \|/)
  } finally {
    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-2: pass bounds parallel Works by workers.list room and --max-parallel', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  try {
    async function runWith(freeAccounts: number, extraArgs: string[]) {
      const done = new Set<string>()
      let running = 0
      let peak = 0
      let seq = 0
      const workItem = new Map<string, string>()
      let lastItem = ''
      const reports: string[] = []
      const host = fakeHost({
        status: () => ['i-1', 'i-2', 'i-3', 'i-4'].map((id) => (done.has(id) ? `[x] ${id} Item - done` : `[ ] ${id} Item - todo: nobody`)),
        'workers.list': () => ({ registered: ['a', 'b', 'c'], accounts: [], room: { accounts: freeAccounts, free: Math.max(0, freeAccounts - running), unknown: [], ready: [] } }),
        'work.list': () => [],
        'item.claim': () => ({ who: 'tan', at: 'T' }),
        'task.new': (p) => { lastItem = p.item!; return { task: `sha256:t${++seq}` } },
        'work.submit': () => { const id = `work:${seq}`; workItem.set(id, lastItem); return { id } },
        'artifact.put': (p) => { reports.push(Buffer.from(p.data, 'base64').toString('utf8')); return { id: 'sha256:report-par' } },
      }, {
        run: async (id) => {
          running += 1
          peak = Math.max(peak, running)
          await new Promise((r) => setTimeout(r, 25))
          running -= 1
          const item = workItem.get(id)!
          done.add(item)
          return workRecord(id, repo, item, 'succeeded', { merged: true, account: 'claude/a' })
        },
      })
      const res = await system(['items', 'carry', '--repo', repo, ...extraArgs], host, home)
      assert.equal(res.code, 0, res.err)
      assert.equal(res.out.trim(), 'sha256:report-par')
      assert.equal(reports.length, 1)
      for (const id of ['i-1', 'i-2', 'i-3', 'i-4']) assert.match(reports[0]!, new RegExp(`\\| ${id} \\|`))
      return peak
    }

    assert.equal(await runWith(2, []), 2, 'bounded by room.free = 2')
    assert.equal(await runWith(3, ['--max-parallel', '2']), 2, 'bounded by --max-parallel 2 when room.free = 3')
    assert.equal(await runWith(2, ['--max-parallel', '4']), 2, 'bounded by room.free = 2 when --max-parallel 4')
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-2: pass lock rejects a second concurrent pass for the same repositories and releases when the first ends', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repoA = makeRepo()
  const repoB = makeRepo()
  try {
    let releaseWork!: () => void
    let workStarted!: () => void
    const started = new Promise<void>((r) => { workStarted = r })
    const gate = new Promise<void>((r) => { releaseWork = r })
    let done = false

    const host1 = fakeHost({
      status: ({ repository }) => (repository === repoA ? [done ? '[x] a-1 One - done' : '[ ] a-1 One - todo: nobody'] : []),
      'workers.list': () => ({ registered: ['a'], accounts: [], room: { accounts: 1, free: 1, unknown: [], ready: [] } }),
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': () => ({ task: 'sha256:t1' }),
      'work.submit': () => ({ id: 'work:1' }),
      'artifact.put': () => ({ id: 'sha256:report-lock' }),
    }, {
      run: async (id) => {
        workStarted()
        await gate
        done = true
        return workRecord(id, repoA, 'a-1', 'succeeded', { merged: true })
      },
    })

    const pass1 = system(['items', 'carry', '--repo', repoA, '--repo', repoB], host1, home)
    await started

    // Second pass for the same repositories (even in reversed order) exits at once without calling the Host
    const neverCall = () => { throw new Error('must not call Host while locked') }
    const pass2 = await system(['items', 'carry', '--repo', repoB, '--repo', repoA], fakeHost({ status: neverCall }), home)
    assert.equal(pass2.code, 1)
    assert.match(pass2.err, /already running/i)

    // Once pass1 ends, the lock is gone and a new pass can enter
    releaseWork()
    assert.equal((await pass1).code, 0)

    const pass3 = await system(['items', 'carry', '--repo', repoA], fakeHost({
      status: () => ['[x] a-1 One - done'],
    }), home)
    assert.equal(pass3.code, 0, pass3.err)
  } finally {
    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-2: pass lock is gone when a process holding it is SIGKILLed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  const itemsUrl = new URL('../src/items.ts', import.meta.url).href
  const child = spawn(process.execPath, [
    '-e',
    `import(${JSON.stringify(itemsUrl)}).then(async ({ acquirePassLock }) => { const l = await acquirePassLock(${JSON.stringify(home)}, [${JSON.stringify(repo)}]); if ('busy' in l) process.exit(2); process.stdout.write('locked\\n'); setInterval(() => {}, 60000); })`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk.toString(); if (out.includes('locked')) resolve() })
      child.once('exit', (code) => reject(new Error(`child exited early: ${code}`)))
    })
    const blocked = await system(['items', 'carry', '--repo', repo], fakeHost({ status: () => { throw new Error('must not call Host') } }), home)
    assert.equal(blocked.code, 1)
    assert.match(blocked.err, /already running/i)

    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))

    const afterKill = await system(['items', 'carry', '--repo', repo], fakeHost({ status: () => [] }), home)
    assert.equal(afterKill.code, 0, afterKill.err)
  } finally {
    child.kill('SIGKILL')
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-2: re-entry after a killed pass reads Claims and Works from status and submits nothing twice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  const prevOp = process.env.SYSTEM_OPERATOR_ID
  process.env.SYSTEM_OPERATOR_ID = 'tan'
  try {
    const merged = new Set<string>()
    const submittedItems: string[] = []
    const waitedWorks: string[] = []
    const ranWorks: string[] = []
    let seq = 0
    const workItem = new Map<string, string>()

    const host = fakeHost({
      status: () => [
        // Claimed by killed pass before work.submit -> should submit once
        merged.has('a-1') ? '[x] a-1 Claimed - done' : '[ ] a-1 Claimed - doing: claimed by tan since T; idle since T',
        // Already running Work from killed pass -> should wait, NOT submit again
        merged.has('a-2') ? '[x] a-2 Running - done' : '[ ] a-2 Running - doing: work:prev step implement on claude/a since T',
        // Blocked by a-2 -> becomes Ready once work:prev merges!
        merged.has('a-3') ? '[x] a-3 After running - done' : merged.has('a-2') ? '[ ] a-3 After running - todo: nobody' : '[ ] a-3 After running - todo (blocked by a-2)',
        // Held Work from killed pass -> skip, do not submit or wait
        '[ ] a-4 Held - doing: work:held step publish on claude/a since T; held: gate approval',
        // Admitted, not running Work from killed pass -> run it, do NOT submit again
        merged.has('a-5') ? '[x] a-5 Admitted - done' : '[ ] a-5 Admitted - doing: work:adm admitted, not running since T',
      ],
      'workers.list': () => ({ registered: ['a', 'b', 'c'], accounts: [], room: { accounts: 3, free: 3, unknown: [], ready: [] } }),
      'work.list': () => [
        { id: 'work:prev', status: merged.has('a-2') ? 'succeeded' : 'running', specId: 'sha256:s', item: 'a-2' },
        { id: 'work:held', status: 'held', specId: 'sha256:s', item: 'a-4' },
        { id: 'work:adm', status: merged.has('a-5') ? 'succeeded' : 'running', specId: 'sha256:s', item: 'a-5' },
      ],
      'work.show': ({ workId }) => {
        if (workId === 'work:prev') return workRecord('work:prev', repo, 'a-2', merged.has('a-2') ? 'succeeded' : 'running', { merged: merged.has('a-2'), account: 'claude/a' })
        if (workId === 'work:held') return workRecord('work:held', repo, 'a-4', 'held', { account: 'claude/a', reason: 'gate approval' })
        if (workId === 'work:adm') {
          const rec = workRecord('work:adm', repo, 'a-5', merged.has('a-5') ? 'succeeded' : 'running', { merged: merged.has('a-5') })
          if (!merged.has('a-5')) rec.events = [rec.events[0]]
          return rec
        }
        throw new Error(`unexpected work.show ${workId}`)
      },
      'item.claim': ({ item }) => {
        assert.notEqual(item, 'a-2', 'must not re-claim item with running Work')
        assert.notEqual(item, 'a-4', 'must not claim held item')
        assert.notEqual(item, 'a-5', 'must not re-claim item with admitted Work')
        return { who: 'tan', at: 'T' }
      },
      'task.new': ({ item }) => {
        submittedItems.push(item!)
        return { task: `sha256:t${++seq}` }
      },
      'work.submit': () => {
        const id = `work:new-${seq}`
        workItem.set(id, submittedItems.at(-1)!)
        return { id }
      },
      'artifact.put': () => ({ id: 'sha256:report-reentry' }),
    }, {
      wait: async (id) => {
        waitedWorks.push(id)
        if (id === 'work:prev') {
          merged.add('a-2')
          return workRecord(id, repo, 'a-2', 'succeeded', { merged: true, account: 'claude/a' })
        }
        throw new Error(`unexpected wait ${id}`)
      },
      run: async (id) => {
        ranWorks.push(id)
        if (id === 'work:adm') {
          merged.add('a-5')
          return workRecord(id, repo, 'a-5', 'succeeded', { merged: true, account: 'claude/a' })
        }
        const item = workItem.get(id)!
        merged.add(item)
        return workRecord(id, repo, item, 'succeeded', { merged: true, account: 'claude/a' })
      },
    })

    const res = await system(['items', 'carry', '--repo', repo], host, home)
    assert.equal(res.code, 0, res.err)
    assert.deepEqual(waitedWorks, ['work:prev'])
    assert.ok(ranWorks.includes('work:adm'), 'admitted Work was started with run, not submitted twice')
    assert.deepEqual(submittedItems.sort(), ['a-1', 'a-3'])
  } finally {
    if (prevOp === undefined) delete process.env.SYSTEM_OPERATOR_ID
    else process.env.SYSTEM_OPERATOR_ID = prevOp
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})


async function startNotifyListener(statusCode = 200) {
  const received: { method: string; body: string }[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      received.push({ method: req.method ?? '', body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(statusCode, { 'content-type': 'text/plain' })
      res.end(statusCode >= 400 ? 'error' : 'ok')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('expected TCP address')
  const url = `http://127.0.0.1:${addr.port}/notify`
  const close = () => new Promise<void>((resolve) => { server.close(() => resolve()) })
  return { url, received, close }
}

async function withNotifyEnv<T>(env: { url?: string; command?: string }, fn: () => Promise<T>): Promise<T> {
  const prevUrl = process.env.SYSTEM_SCHEDULE_NOTIFY_URL
  const prevCmd = process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND
  if (env.url === undefined) delete process.env.SYSTEM_SCHEDULE_NOTIFY_URL
  else process.env.SYSTEM_SCHEDULE_NOTIFY_URL = env.url
  if (env.command === undefined) delete process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND
  else process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND = env.command
  try {
    return await fn()
  } finally {
    if (prevUrl === undefined) delete process.env.SYSTEM_SCHEDULE_NOTIFY_URL
    else process.env.SYSTEM_SCHEDULE_NOTIFY_URL = prevUrl
    if (prevCmd === undefined) delete process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND
    else process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND = prevCmd
  }
}

test('sch-3: pass stores Markdown report Artifact (Works, outcome, Account, tokens, cache-read share, cost, skipped with reason), prints its ID, and POSTs one line to SYSTEM_SCHEDULE_NOTIFY_URL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  const listener = await startNotifyListener()
  try {
    const done = new Set<string>()
    let seq = 0
    const workItem = new Map<string, string>()
    let lastItem = ''
    const stored: { mediaType?: string; body: string }[] = []

    const host = fakeHost({
      status: () => [
        done.has('a-1') ? '[x] a-1 Merged item - done' : '[ ] a-1 Merged item - todo: nobody',
        done.has('a-2') ? '[ ] a-2 Held item - doing: work:2 step publish on codex/b since T; held: gate approval' : '[ ] a-2 Held item - todo: nobody',
        '[ ] a-3 Two fails - todo: nobody',
      ],
      'workers.list': () => ({ registered: ['claude/a', 'codex/b'], accounts: [], room: { accounts: 2, free: 2, unknown: [], ready: [] } }),
      'work.list': () => [
        { id: 'work:old1', status: 'failed', specId: 'sha256:s', item: 'a-3' },
        { id: 'work:old2', status: 'failed', specId: 'sha256:s', item: 'a-3' },
      ],
      'work.show': ({ workId }) => workRecord(workId, repo, 'a-3', 'failed'),
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': (p) => { lastItem = p.item!; return { task: `sha256:t${++seq}` } },
      'work.submit': () => { const id = `work:${seq}`; workItem.set(id, lastItem); return { id } },
      'artifact.put': (p) => {
        stored.push({ mediaType: p.mediaType, body: Buffer.from(p.data, 'base64').toString('utf8') })
        return { id: 'sha256:report-sch3-ok' }
      },
    }, {
      run: async (id) => {
        const item = workItem.get(id)!
        done.add(item)
        if (item === 'a-1') {
          return workRecord(id, repo, item, 'succeeded', {
            merged: true,
            account: 'claude/a',
            inputTokens: 100,
            cacheReadTokens: 80,
            outputTokens: 25,
            costUsd: 0.42,
          })
        }
        return workRecord(id, repo, item, 'held', {
          account: 'codex/b',
          inputTokens: 50,
          outputTokens: 10,
          reason: 'gate approval',
        })
      },
    })

    const res = await withNotifyEnv({ url: listener.url }, () => system(['items', 'carry', '--repo', repo], host, home))
    assert.equal(res.code, 0, res.err)
    assert.equal(res.out.trim(), 'sha256:report-sch3-ok')

    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.mediaType, 'text/markdown')
    const md = stored[0]!.body
    assert.match(md, /## Items/)
    assert.match(md, /\| a-1 \|.*\| work:1 \| merged \| claude\/a \| 125 \| 80% \| \$0\.42 \|/)
    assert.match(md, /\| a-2 \|.*\| work:2 \| held \| codex\/b \| 60 \| unknown \| unknown \|/)
    assert.match(md, /## Items skipped/)
    assert.match(md, /a-3.*already has 2 failed Works/)

    assert.equal(listener.received.length, 1)
    assert.equal(listener.received[0]!.method, 'POST')
    const line = listener.received[0]!.body
    assert.ok(!line.includes('\n'), 'notifier payload is one line')
    assert.match(line, /^\d{4}-\d{2}-\d{2} /)
    assert.ok(line.includes(basename(repo)), `line names repo: ${line}`)
    assert.match(line, /merged 1, held 1, failed 0, skipped 1/)
    assert.ok(line.includes('sha256:report-sch3-ok'), `line names report ID: ${line}`)
  } finally {
    await listener.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-3: pass exits 1 and notifies with counts and report ID when an Item it took ended failed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  const listener = await startNotifyListener()
  try {
    let seq = 0
    const host = fakeHost({
      status: () => ['[ ] f-1 Broken item - todo: nobody'],
      'workers.list': () => ({ registered: ['claude/a'], accounts: [], room: { accounts: 1, free: 1, unknown: [], ready: [] } }),
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': () => ({ task: `sha256:t${++seq}` }),
      'work.submit': () => ({ id: `work:${seq}` }),
      'artifact.put': () => ({ id: 'sha256:report-fail' }),
    }, {
      run: async (id) => workRecord(id, repo, 'f-1', 'failed', { account: 'claude/a', verdictId: `sha256:v-${id}`, reason: 'checks failed' }),
    })

    const res = await withNotifyEnv({ url: listener.url }, () => system(['items', 'carry', '--repo', repo], host, home))
    assert.equal(res.code, 1)
    assert.equal(res.out.trim(), 'sha256:report-fail')
    assert.equal(listener.received.length, 1)
    const line = listener.received[0]!.body
    assert.ok(!line.includes('\n'))
    assert.match(line, /merged 0, held 0, failed 1, skipped 0/)
    assert.ok(line.includes('sha256:report-fail'))
  } finally {
    await listener.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-3: pass exits 1 and notifies with cause when the Host does not answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  const listener = await startNotifyListener()
  try {
    const neverPut = () => { throw new Error('must not call artifact.put when Host is down') }

    const notRunningHost = fakeHost({
      status: () => { throw new NotRunning('socket missing') },
      'artifact.put': neverPut,
    })
    const res1 = await withNotifyEnv({ url: listener.url }, () => system(['items', 'carry', '--repo', repo], notRunningHost, home))
    assert.equal(res1.code, 1)
    assert.equal(res1.out, '')
    assert.match(res1.err, /not running/i)
    assert.equal(listener.received.length, 1)
    assert.ok(!listener.received[0]!.body.includes('\n'))
    assert.match(listener.received[0]!.body, /cause:.*not running/i)

    const notAnsweringHost = fakeHost({
      status: () => { throw new NotAnswering('status timed out after 10000 ms') },
      'artifact.put': neverPut,
    })
    const res2 = await withNotifyEnv({ url: listener.url }, () => system(['items', 'carry', '--repo', repo], notAnsweringHost, home))
    assert.equal(res2.code, 1)
    assert.equal(res2.out, '')
    assert.match(res2.err, /not answering/i)
    assert.equal(listener.received.length, 2)
    assert.match(listener.received[1]!.body, /cause:.*not answering/i)
  } finally {
    await listener.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-3: pass exits 1 and notifies with cause when a repository status cannot be read', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  const listener = await startNotifyListener()
  try {
    const hostThrow = fakeHost({
      status: () => { throw new Error('not a git repository') },
      'artifact.put': () => ({ id: 'sha256:report-err1' }),
    })
    const res1 = await withNotifyEnv({ url: listener.url }, () => system(['items', 'carry', '--repo', repo], hostThrow, home))
    assert.equal(res1.code, 1)
    assert.equal(res1.out.trim(), 'sha256:report-err1')
    assert.match(res1.err, /not a git repository/)
    assert.equal(listener.received.length, 1)
    assert.match(listener.received[0]!.body, /cause:.*not a git repository/)

    const hostMissing = fakeHost({
      status: () => [`note: no STATUS.md on dev (abc123456789) in ${repo}`],
      'artifact.put': () => ({ id: 'sha256:report-err2' }),
    })
    const res2 = await withNotifyEnv({ url: listener.url }, () => system(['items', 'carry', '--repo', repo], hostMissing, home))
    assert.equal(res2.code, 1)
    assert.equal(res2.out.trim(), 'sha256:report-err2')
    assert.match(res2.err, /no STATUS\.md/)
    assert.equal(listener.received.length, 2)
    assert.match(listener.received[1]!.body, /cause:.*no STATUS\.md/)
  } finally {
    await listener.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-3: pass that finds nothing Ready exits 0, stores no report, and never notifies', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  const listener = await startNotifyListener()
  try {
    const host = fakeHost({
      status: () => ['[x] a-1 Already done - done', '[ ] a-2 Blocked - todo (blocked by a-3)'],
      'artifact.put': () => { throw new Error('must not store report when nothing Ready') },
    })
    const res = await withNotifyEnv({ url: listener.url }, () => system(['items', 'carry', '--repo', repo], host, home))
    assert.equal(res.code, 0, res.err)
    assert.equal(res.out, '')
    assert.equal(listener.received.length, 0)
  } finally {
    await listener.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-3: SYSTEM_SCHEDULE_NOTIFY_COMMAND receives the one-line verdict as $1', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  const outFile = join(home, 'notified.txt')
  try {
    let done = false
    const host = fakeHost({
      status: () => [done ? '[x] c-1 One - done' : '[ ] c-1 One - todo: nobody'],
      'workers.list': () => ({ registered: ['claude/a'], accounts: [], room: { accounts: 1, free: 1, unknown: [], ready: [] } }),
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': () => ({ task: 'sha256:t1' }),
      'work.submit': () => ({ id: 'work:1' }),
      'artifact.put': () => ({ id: 'sha256:report-cmd' }),
    }, {
      run: async (id) => {
        done = true
        return workRecord(id, repo, 'c-1', 'succeeded', { merged: true, account: 'claude/a' })
      },
    })
    const cmd = `printf '%s' "$1" > ${JSON.stringify(outFile)}`
    const res = await withNotifyEnv({ command: cmd }, () => system(['items', 'carry', '--repo', repo], host, home))
    assert.equal(res.code, 0, res.err)
    const line = readFileSync(outFile, 'utf8')
    assert.ok(!line.includes('\n'))
    assert.match(line, /^\d{4}-\d{2}-\d{2} /)
    assert.ok(line.includes(basename(repo)))
    assert.match(line, /merged 1, held 0, failed 0, skipped 0/)
    assert.ok(line.includes('sha256:report-cmd'))
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-3: a failing notifier is said on stderr and does not change the exit code', async () => {
  const home = mkdtempSync(join(tmpdir(), 'system-pass-home-'))
  const repo = makeRepo()
  const listener = await startNotifyListener(500)
  try {
    let done = false
    const okHost = fakeHost({
      status: () => [done ? '[x] n-1 One - done' : '[ ] n-1 One - todo: nobody'],
      'workers.list': () => ({ registered: ['claude/a'], accounts: [], room: { accounts: 1, free: 1, unknown: [], ready: [] } }),
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': () => ({ task: 'sha256:t1' }),
      'work.submit': () => ({ id: 'work:1' }),
      'artifact.put': () => ({ id: 'sha256:report-n1' }),
    }, {
      run: async (id) => {
        done = true
        return workRecord(id, repo, 'n-1', 'succeeded', { merged: true, account: 'claude/a' })
      },
    })
    const okRes = await withNotifyEnv({ url: listener.url, command: 'echo boom >&2; exit 7' }, () => system(['items', 'carry', '--repo', repo], okHost, home))
    assert.equal(okRes.code, 0, 'failing notifier must not turn exit 0 into non-zero')
    assert.match(okRes.err, /notifier URL failed/i)
    assert.match(okRes.err, /notifier command failed/i)
    assert.equal(listener.received.length, 1)

    let seq = 0
    const failHost = fakeHost({
      status: () => ['[ ] n-2 Fail - todo: nobody'],
      'workers.list': () => ({ registered: ['claude/a'], accounts: [], room: { accounts: 1, free: 1, unknown: [], ready: [] } }),
      'work.list': () => [],
      'item.claim': () => ({ who: 'tan', at: 'T' }),
      'task.new': () => ({ task: `sha256:t${++seq}` }),
      'work.submit': () => ({ id: `work:${seq}` }),
      'artifact.put': () => ({ id: 'sha256:report-n2' }),
    }, {
      run: async (id) => workRecord(id, repo, 'n-2', 'failed', { account: 'claude/a' }),
    })
    const failRes = await withNotifyEnv({ url: listener.url, command: 'exit 3' }, () => system(['items', 'carry', '--repo', repo], failHost, home))
    assert.equal(failRes.code, 1, 'failing notifier must keep exit 1')
    assert.match(failRes.err, /notifier URL failed/i)
    assert.match(failRes.err, /notifier command failed/i)
  } finally {
    await listener.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('sch-4: --schedule reads the Schedule file: its repositories in order and maxParallel; it refuses other selectors and kind: work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-items-sched-'))
  const home = mkdtempSync(join(tmpdir(), 'system-items-home-'))
  try {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a)
    mkdirSync(b)
    const file = join(dir, 'night.yaml')
    writeFileSync(file, `kind: items\nrepositories: [${a}, ${b}]\nat: [daily]\nmaxParallel: 1\n`)
    const asked: unknown[] = []
    const host = fakeHost({
      status: (p) => { asked.push(p); return [] },
      'work.list': () => [],
      'workers.list': () => [],
    })
    const res = await system(['items', 'carry', '--schedule', file], host, home)
    assert.equal(res.code, 0, res.err)
    assert.deepEqual(asked, [{ repository: a }, { repository: b }])
    for (const extra of [['--repo', a], ['--max-parallel', '2'], ['a-1']]) {
      await assert.rejects(system(['items', 'carry', '--schedule', file, ...extra], host, home), /--schedule is a pass of its own/)
    }
    writeFileSync(file, 'kind: work\nat: daily\n')
    await assert.rejects(system(['items', 'carry', '--schedule', file], host, home), /kind: work is not built yet/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
