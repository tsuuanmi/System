/**
 * The `runtime-cli` row's Accounts as the Worker registry shows them: every CLI Account is listed from the first moment, with its models and
 * slots; a `web` Account is not this row's (ADR-0018 decision 3), so it is refused with the row to use.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { fakeQuotaCli } from '../../../test-support/quota.ts'
import { TASK_KIND, taskSchema, type WorkerPort } from '@system/work'
import { test } from 'node:test'
import { fakeClaudeHome, fakeCodexHome, tempDir } from '../../../test-support/accounts.ts'
import { REGISTERING, apply } from '../src/index.ts'
import { RUNTIME_ABILITIES } from '../src/runtimes.ts'
import { observed, viewOf } from '../../../test-support/accounts-view.ts'

/** The fake context's `ctx.inject`: the declared services are the ones in `services`, mounted at once. */
const injecting = (services: Record<string, unknown>) => (_names: string[], callback: (ctx: { get(key: string): unknown }) => void): void => { callback({ get: (key) => services[key] }) }

/** `provide` for a bare context: the `agents` service plus the Accounts read from the `capabilities` registry in `services`, as the Host reads them (ADR-0018). */
const providing = (provided: Record<string, any>, services: Record<string, unknown>) => (key: string, value: unknown) => { provided[key] = key === 'agents' ? { ...(value as object), ...viewOf(services.capabilities as never) } : value }

test('an account reports the model of each tier it configures, in tier order, from the first moment', async () => {
  const { before } = await cliMount([claude('claude-code/a', { models: { frontier: 'f', economy: 'e' }, claudeHome: tempDir() }), claude('claude-code/b', { claudeHome: tempDir() })], true)
  assert.deepEqual((before as any[]).map((a) => a.models), [{ economy: 'e', frontier: 'f' }, {}])
})

test('an Account of the web Runtime under this row is refused with the row it belongs to', async () => {
  const { accounts, registered } = await cliMount([{ ref: 'web/chatgpt/default', runtime: 'web', site: 'chatgpt', capabilities: ['research'] }])
  assert.deepEqual([accounts[0].available, registered], [false, []])
  assert.match(accounts[0].reason, /runtime-web row/)
})

test('a CLI account inherits the row\'s slots, and its own wins', async () => {
  const resolved: Record<string, unknown> = {}
  const { accounts } = await cliMount([claude('claude-code/a', { claudeHome: tempDir() }), claude('claude-code/b', { claudeHome: tempDir(), maxConcurrentAttempts: 3 })], false, { maxConcurrentAttempts: 4 }, (w) => { resolved[w.ref] = w.maxConcurrentAttempts })
  assert.deepEqual(accounts.map((a) => a.available), [true, true])
  assert.deepEqual(resolved, { 'claude-code/a': 4, 'claude-code/b': 3 })
})

// Account identity (sc-1): CLI accounts over fake homes.
const cliMount = async (accounts: object[], hold = false, row: object = {}, onWorker: (w: WorkerPort) => void = () => {}): Promise<{ registered: string[]; accounts: any[]; before: any[]; started: Promise<void> }> => {
  const registered: string[] = []
  const provided: Record<string, any> = {}
  const services = {
    storageDomain: { open: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }) },
    capabilities: observed((w) => { registered.push(w.ref); onWorker(w) }),
    artifacts: {}, credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'TOKEN-VALUE' }) },
    subprocess: { resolveExecutable: async (c: string) => c, spawn: () => ({ done: Promise.resolve({}), collected: {} }) },
  } as Record<string, unknown>
  const ctx = { get: (key: string) => services[key], inject: injecting(services), effect: () => {}, provide: providing(provided, services), baseDir: tempDir('base-') }
  const started = apply(ctx as never, { ...row, accounts: accounts as never })
  const before = await provided.agents.accounts() as any[]
  if (hold) return { registered, before, accounts: before, started }
  await started
  return { registered, before, accounts: await provided.agents.accounts() as any[], started }
}
const claude = (ref: string, own: object = {}) => ({ ref, runtime: 'claude-code', capabilities: ['repo.write'], ...own })
const codex = (ref: string, home: string, own: object = {}) => ({ ref, runtime: 'codex', capabilities: ['repo.write'], codexHome: home, ...own })

test('any priority registers and carries a note, including multiple old primaries', async () => {
  const { accounts, registered } = await cliMount(['primary', 'primary', 'secondary', 'anything'].map((priority, i) => claude(`claude-code/c${i}`, { priority, claudeHome: tempDir() })))
  assert.deepEqual(accounts.map((a) => a.available), [true, true, true, true])
  assert.deepEqual(registered, accounts.map((a) => a.ref))
  for (const account of accounts) {
    assert.match(account.note ?? '', /priority is ignored/)
    assert.equal(account.priority, undefined)
  }
})

test('a duplicate provider account is refused for the later account with the first ref in the reason', async () => {
  const one = fakeCodexHome(undefined, 'acct-1')
  const two = fakeCodexHome(undefined, 'acct-1')
  const { accounts, registered } = await cliMount([codex('codex/x1', one), codex('codex/x2', two)])
  assert.deepEqual([accounts[0].available, accounts[0].providerAccount], [true, 'acct-1'])
  assert.deepEqual([accounts[1].available, accounts[1].providerAccount], [false, 'acct-1'])
  assert.equal(accounts[1].reason, 'provider account acct-1 is already registered as codex/x1; two refs on one account would count its quota twice')
  assert.deepEqual(registered, ['codex/x1'])
  const swapped = await cliMount([codex('codex/x2', two), codex('codex/x1', one)])
  assert.deepEqual(swapped.accounts.map((a) => a.available), [true, false])
})

test('two Claude accounts on one accountUuid, or one emailAddress, collide; another Runtime with that ID does not', async () => {
  for (const id of [{ accountUuid: 'u-1' }, { emailAddress: 'me@example.com' }]) {
    const { accounts } = await cliMount([claude('claude-code/c1', { claudeHome: fakeClaudeHome(undefined, id) }), claude('claude-code/c2', { claudeHome: fakeClaudeHome(undefined, id) })])
    assert.deepEqual(accounts.map((a) => a.available), [true, false])
  }
  const { accounts } = await cliMount([claude('claude-code/c1', { claudeHome: fakeClaudeHome(undefined, { accountUuid: 'same' }) }), codex('codex/x1', fakeCodexHome(undefined, 'same'))])
  assert.deepEqual(accounts.map((a) => a.available), [true, true])
})

test('an unreadable ID leaves the account registered with the ID unknown', async () => {
  const { accounts, registered } = await cliMount([codex('codex/x1', fakeCodexHome(undefined)), codex('codex/x2', fakeCodexHome(undefined)), claude('claude-code/c1', { claudeHome: tempDir() }), claude('claude-code/c2', { claudeHome: tempDir() })])
  assert.deepEqual(accounts.map((a) => [a.available, a.reason, a.providerAccount]), Array(4).fill([true, 'registered', undefined]))
  assert.equal(registered.length, 4)
})

test('the listing shows label, ignored-priority note and provider account from the first moment, and no secret', async () => {
  const specs = [claude('claude-code/c1', { label: 'me@example.com', priority: 'primary', claudeHome: fakeClaudeHome(undefined, { accountUuid: 'u-1' }) }), codex('codex/x1', fakeCodexHome(undefined, 'acct-1'))]
  const { before, started } = await cliMount(specs, true)
  assert.deepEqual(before.map((a) => [a.label, a.note]), [['me@example.com', 'priority is ignored: routing goes by quota headroom'], [undefined, undefined]])
  await started
  const { accounts } = await cliMount(specs)
  assert.deepEqual(accounts.map((a) => [a.label, a.note, a.providerAccount]), [['me@example.com', 'priority is ignored: routing goes by quota headroom', 'u-1'], [undefined, undefined, 'acct-1']])
  assert.doesNotMatch(JSON.stringify(accounts), /SECRET-|TOKEN-VALUE/)
})

test('a ref without a rename stays valid', async () => {
  const { accounts } = await cliMount([claude('claude-code/default')])
  assert.deepEqual([accounts[0].available, accounts[0].priority], [true, undefined])
})

test('a Claude account reads the last rate_limit_event after the Host restarts', async (t) => {
  const dir = tempDir('agents-restart-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = fakeQuotaCli(join(dir, 'cli'), { kind: 'claude', version: '2.1.322', answer: { rate_limits_available: false, rate_limits: {} } })
  const rows = new Map<string, unknown>()
  const storageDomain = { open: async () => ({ table: () => ({
    get: (key: string) => structuredClone(rows.get(key)),
    put: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)) },
  }), close: async () => {} }) }
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema })
  const task = await artifacts.put({ ...TASK_KIND, content: { instructions: 'observe quota' }, classification: 'local-private', producer: { type: 'operator', ref: 'test' } })
  const stream = [
    { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: .77, status: 'allowed' } },
    { type: 'result', subtype: 'success', result: 'done', is_error: false, structured_output: { status: 'done', reason: 'done' } },
  ].map((event) => JSON.stringify(event)).join('\n')
  const mountAgain = async () => {
    let worker!: WorkerPort
    let agents: any
    const effects: (() => () => void)[] = []
    const services: Record<string, unknown> = {
      storageDomain, artifacts, dshHomePath: (...parts: string[]) => join(dir, ...parts),
      credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'token' }) },
      capabilities: observed((port) => { worker = port }),
      subprocess: { resolveExecutable: async () => fake.command, spawn: (spec: { argv: string[] }) => ({
        done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit: async () => true,
        collected: { stdout: { readFrom: () => ({ text: spec.argv.includes('--version') ? '2.1.322 (Claude Code)' : stream }) } },
      }) },
    }
    await apply({ get: (key: string) => services[key], inject: injecting(services), provide: (_key: string, value: unknown) => { agents = { ...(value as object), ...viewOf(services.capabilities as never) } }, effect: (fn: () => () => void) => { effects.push(fn) } } as never,
      { accounts: [claude('claude-code/restart', { command: fake.command, claudeHome: join(dir, 'home') })] } as never)
    return { worker, agents, unload: () => effects.forEach((fn) => fn()()) }
  }
  const first = await mountAgain()
  const result = await first.worker.run({ workId: 'work:restart', attemptId: 'attempt:restart', stepId: 'task', capabilities: ['research'], inputs: { task: task.id }, outputs: [], signal: new AbortController().signal })
  assert.equal(result.status, 'succeeded', result.reason)
  const before = await first.agents.quota('claude-code/restart')
  assert.equal(before.source, 'rate_limit_event', JSON.stringify(before))
  assert.equal(before.windows.seven_day.percentUsed, 77)
  await new Promise<void>((resolve) => setImmediate(resolve))
  first.unload()
  const second = await mountAgain()
  t.after(second.unload)
  const after = await second.agents.quota('claude-code/restart')
  assert.deepEqual(after, before)
})

test('a Claude account reads the last rate_limit_event even when the CLI version is not verified', async (t) => {
  const dir = tempDir('agents-restart-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fake = fakeQuotaCli(join(dir, 'cli'), { kind: 'claude', version: '2.1.325', answer: { rate_limits_available: false, rate_limits: {} } })
  const rows = new Map<string, unknown>()
  const storageDomain = { open: async () => ({ table: () => ({
    get: (key: string) => structuredClone(rows.get(key)),
    put: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)) },
  }), close: async () => {} }) }
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema })
  const task = await artifacts.put({ ...TASK_KIND, content: { instructions: 'observe quota' }, classification: 'local-private', producer: { type: 'operator', ref: 'test' } })
  const stream = [
    { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: .77, status: 'allowed' } },
    { type: 'result', subtype: 'success', result: 'done', is_error: false, structured_output: { status: 'done', reason: 'done' } },
  ].map((event) => JSON.stringify(event)).join('\n')
  const mountAgain = async () => {
    let worker!: WorkerPort
    let agents: any
    const effects: (() => () => void)[] = []
    const services: Record<string, unknown> = {
      storageDomain, artifacts, dshHomePath: (...parts: string[]) => join(dir, ...parts),
      credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'token' }) },
      capabilities: observed((port) => { worker = port }),
      subprocess: { resolveExecutable: async () => fake.command, spawn: (spec: { argv: string[] }) => ({
        done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit: async () => true,
        collected: { stdout: { readFrom: () => ({ text: spec.argv.includes('--version') ? '2.1.325 (Claude Code)' : stream }) } },
      }) },
    }
    await apply({ get: (key: string) => services[key], inject: injecting(services), provide: (_key: string, value: unknown) => { agents = { ...(value as object), ...viewOf(services.capabilities as never) } }, effect: (fn: () => () => void) => { effects.push(fn) } } as never,
      { accounts: [claude('claude-code/newer', { command: fake.command, claudeHome: join(dir, 'home') })] } as never)
    return { worker, agents, unload: () => effects.forEach((fn) => fn()()) }
  }
  const first = await mountAgain()
  const result = await first.worker.run({ workId: 'work:newer', attemptId: 'attempt:newer', stepId: 'task', capabilities: ['research'], inputs: { task: task.id }, outputs: [], signal: new AbortController().signal })
  assert.equal(result.status, 'succeeded', result.reason)
  const before = await first.agents.quota('claude-code/newer')
  assert.equal(before.source, 'rate_limit_event', JSON.stringify(before))
  assert.equal(before.windows.seven_day.percentUsed, 77)
  assert.equal(before.unreadable, undefined)
  first.unload()
})

// nm-1: abilities come from the Runtime's adapter in code, not from the profile.
test('each Runtime declares its abilities: Claude Code repo.read, repo.write, web.search; Codex repo.read, repo.write; web web.search, web.browse', () => {
  assert.deepEqual(RUNTIME_ABILITIES['claude-code'], ['repo.read', 'repo.write', 'web.search'])
  assert.deepEqual(RUNTIME_ABILITIES.codex, ['repo.read', 'repo.write'])
  assert.deepEqual(RUNTIME_ABILITIES.web, ['web.search', 'web.browse'])
})

test('a CLI Account registers with its Runtime abilities and what its profile grants; status lists them apart', async () => {
  const ports: WorkerPort[] = []
  const provided: Record<string, any> = {}
  const services = {
    storageDomain: { open: async () => ({ table: () => ({ get: () => undefined, put: async () => {} }), close: async () => {} }) },
    capabilities: observed((w) => { ports.push(w) }),
    artifacts: {}, credentials: { describe: async () => ({ configured: true }), resolve: async () => ({ value: 'TOKEN-VALUE' }) },
    subprocess: { resolveExecutable: async (c: string) => c, spawn: () => ({ done: Promise.resolve({}), collected: {} }) },
  } as Record<string, unknown>
  const ctx = { get: (key: string) => services[key], inject: injecting(services), effect: () => {}, provide: providing(provided, services), baseDir: tempDir('base-') }
  await apply(ctx as never, { accounts: [
    claude('claude-code/a', { claudeHome: tempDir(), capabilities: ['develop.implement', 'research'], models: { standard: 'm' } }),
    codex('codex/b', fakeCodexHome(undefined, 'acct-b'), { capabilities: ['research'] }),
  ] as never })
  const [a, b] = ports
  for (const need of ['repo.read', 'repo.write', 'web.search', 'develop.implement', 'research', 'tier.standard']) assert.ok(a!.capabilities.includes(need), `claude ${need}`)
  assert.ok(b!.capabilities.includes('repo.write') && b!.capabilities.includes('research'))
  assert.ok(!b!.capabilities.includes('web.search'), 'codex has no web.search')
  const status = await provided.agents.accounts() as { ref: string; abilities: string[]; capabilities: string[] }[]
  assert.deepEqual(status.map((s) => [s.ref, s.abilities, s.capabilities]), [
    ['claude-code/a', ['repo.read', 'repo.write', 'web.search'], ['develop.implement', 'research', 'tier.standard']],
    ['codex/b', ['repo.read', 'repo.write'], ['research']],
  ])
})

test('the sandbox option is refused unless it is true, a shape of sb-1', async () => {
  const old = await cliMount([claude('claude-code/x', { claudeHome: tempDir(), sandbox: { allowRead: ['/x'] } })])
  assert.match(old.accounts[0].reason, /sandbox must be true/)
})
