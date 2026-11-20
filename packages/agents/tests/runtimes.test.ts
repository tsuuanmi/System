import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseEnv } from '../src/runtimes.ts'
import { adapterFor, checkSandbox } from '../src/adapters/index.ts'


const claude = adapterFor('claude-code')!
const codex = adapterFor('codex')!
const parseClaude = (out: string) => claude.parse(out)
const parseCodex = (out: string) => codex.parse(out)
const claudeInvocation = (command: string, ws: never, prompt: string, token: string, model?: string, codeWrite = false) => claude.invocation({ command, ws, prompt, model, codeWrite, env: { CLAUDE_CODE_OAUTH_TOKEN: token } })
const codexInvocation = (command: string, ws: never, prompt: string, home: string, model?: string) => codex.invocation({ command, ws, prompt, model, codeWrite: false, env: { CODEX_HOME: home } })

const line = (value: unknown) => JSON.stringify(value)

test('Codex usage is summed over completed turns, cache read apart and no cache write', () => {
  const out = [line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }), line({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 } })].join('\n')
  assert.deepEqual(parseCodex(out).usage, { inputTokens: 15, cacheReadTokens: 4, outputTokens: 3, source: 'codex turn.completed usage over 2 turn(s) (input_tokens includes cached_input_tokens)' })
})

test('Codex usage without cached_input_tokens in every turn has no cache split', () => {
  const out = [line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }), line({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } })].join('\n')
  assert.deepEqual(parseCodex(out).usage, { inputTokens: 15, outputTokens: 3, source: 'codex turn.completed usage over 2 turn(s) (input_tokens includes cached_input_tokens)' })
})

test('a Codex turn without token counts makes usage unknown, never zero', () => {
  const out = [line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }), line({ type: 'turn.completed', usage: { input_tokens: 5 } })].join('\n')
  assert.equal(parseCodex(out).usage, undefined)
  assert.equal(parseCodex(line({ type: 'turn.completed' })).usage, undefined)
})

const SOURCE = (n: number) => `claude-code usage (excludes subagents) over ${n} result(s) (input_tokens is fresh; total adds cache_creation and cache_read); cost is a client-side API-equivalent estimate`
const MODEL_SOURCE = (n: number) => `claude-code modelUsage (includes subagents) over ${n} result(s) (inputTokens is fresh; total adds cache_creation and cache_read); cost is a client-side API-equivalent estimate`
const tokens = (inputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, costUSD?: number) => ({ inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens, ...(costUSD === undefined ? {} : { costUSD }) })
const result = (usage: Record<string, number> | undefined, extra: Record<string, unknown> = {}) => line({ type: 'result', is_error: false, result: 'ok', usage, ...extra })

test('Claude Code usage without both token counts is unknown', () => {
  assert.equal(parseClaude(result({ input_tokens: 3 })).usage, undefined)
  assert.deepEqual(parseClaude(result({ input_tokens: 3, output_tokens: 4 })).usage, { inputTokens: 3, outputTokens: 4, source: SOURCE(1) })
  assert.deepEqual(parseClaude(result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 4 })).usage, { inputTokens: 33, cacheReadTokens: 20, cacheWriteTokens: 10, outputTokens: 4, source: SOURCE(1) })
})

test('Claude Code usage is summed over every result, such as the turn a background command starts', () => {
  const out = [
    line({ type: 'system', subtype: 'init' }),
    result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }),
    result({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, output_tokens: 6 }),
  ].join('\n')
  assert.deepEqual(parseClaude(out).usage, { inputTokens: 40, cacheReadTokens: 24, cacheWriteTokens: 12, outputTokens: 11, source: SOURCE(2) })
})

test('Claude Code tokens come from modelUsage, so a subagent\'s model is counted though result.usage excludes it', () => {
  const out = [
    result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }, { modelUsage: { main: tokens(3, 20, 10, 5, 0.5), subagent: tokens(100, 200, 50, 40, 0.25) } }),
    result({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, output_tokens: 6 }, { modelUsage: { main: tokens(1, 4, 2, 6, 0.125) } }),
  ].join('\n')
  assert.deepEqual(parseClaude(out).usage, { inputTokens: 33 + 350 + 7, cacheReadTokens: 224, cacheWriteTokens: 62, outputTokens: 51, costUsd: 0.875, source: MODEL_SOURCE(2) })
})

test('Claude Code modelUsage without costUSD in every model leaves cost absent; usage is the fallback only when modelUsage is absent', () => {
  const usage = { input_tokens: 1, output_tokens: 1 }
  const noCost = parseClaude(result(usage, { modelUsage: { main: tokens(7, 0, 0, 2), other: tokens(1, 0, 0, 1, 0.5) } })).usage
  assert.deepEqual(noCost, { inputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3, source: MODEL_SOURCE(1) })
  assert.deepEqual(parseClaude(result(usage, { modelUsage: {} })).usage, { inputTokens: 1, outputTokens: 1, source: SOURCE(1) })
  assert.deepEqual(parseClaude([result(usage, { modelUsage: { main: tokens(7, 0, 0, 2, 1) } }), result(usage)].join('\n')).usage, { inputTokens: 2, outputTokens: 2, source: SOURCE(2) })
})

test('Claude Code cost is the sum of every result\'s total_cost_usd, and absent unless every result reports it', () => {
  const usage = { input_tokens: 1, output_tokens: 1 }
  assert.equal(parseClaude([result(usage, { total_cost_usd: 0.5 }), result(usage, { total_cost_usd: 0.25 })].join('\n')).usage?.costUsd, 0.75)
  assert.equal(parseClaude([result(usage, { total_cost_usd: 0.5 }), result(usage)].join('\n')).usage?.costUsd, undefined)
  assert.equal(parseClaude(result(usage)).usage && 'costUsd' in parseClaude(result(usage)).usage!, false)
})

test('the last Claude Code result decides success and the message; served models are the union', () => {
  const usage = { input_tokens: 1, output_tokens: 1 }
  const failedLast = parseClaude([result(usage, { result: 'first', modelUsage: { b: {} } }), result(usage, { is_error: true, result: 'second', modelUsage: { a: {} } })].join('\n'))
  assert.equal(failedLast.ok, false)
  assert.equal(failedLast.message, 'second')
  assert.deepEqual(failedLast.servedModels, ['a', 'b'])
  const okLast = parseClaude([result(usage, { is_error: true, result: 'first' }), result(usage, { result: 'second' })].join('\n'))
  assert.equal(okLast.ok, true)
  assert.equal(okLast.message, 'second')
})

test('lines that are not JSON or not results are ignored', () => {
  const out = ['warning: not json', line({ type: 'assistant', usage: { input_tokens: 99, output_tokens: 99 } }), result({ input_tokens: 3, output_tokens: 4 }), '{"truncated'].join('\n')
  const parsed = parseClaude(out)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.usage, { inputTokens: 3, outputTokens: 4, source: SOURCE(1) })
})

test('a stream with no result is unreadable output', () => {
  const parsed = parseClaude([line({ type: 'system' }), 'garbage'].join('\n'))
  assert.equal(parsed.ok, false)
  assert.match(parsed.message, /^unreadable Claude Code output: /)
  assert.equal(parsed.usage, undefined)
})

test('Claude Code progress is read as the stream grows: turns are messages, tokens are fresh input, cache writes and output, input tokens include cache reads', () => {
  const read = claude.progress()
  const assistant = (id: string, tool: string | undefined, output: number) => line({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }, ...(tool ? [{ type: 'tool_use', name: tool }] : [])], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: output } } })
  let stdout = `${line({ type: 'system', subtype: 'init' })}\n${assistant('m1', 'Bash', 3)}\n`
  assert.deepEqual(read(stdout), { turns: 1, lastTool: 'Bash', tokens: 18, inputTokens: 115 })
  // A message streamed as several events is one turn, counted once; a half-written line waits for its end.
  const half = assistant('m2', 'Read', 4)
  stdout += `${assistant('m1', 'Bash', 3)}\n${half.slice(0, 20)}`
  assert.deepEqual(read(stdout), { turns: 1, lastTool: 'Bash', tokens: 18, inputTokens: 115 })
  stdout += `${half.slice(20)}\n${assistant('m3', undefined, 1)}\nnot json\n`
  assert.deepEqual(read(stdout), { turns: 3, lastTool: 'Read', tokens: 18 + 19 + 16, inputTokens: 3 * 115 })
})

test('Codex progress counts completed turns and their tokens', () => {
  const read = codex.progress()
  assert.deepEqual(read(`${line({ type: 'item.completed', item: { type: 'command_execution' } })}\n${line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } })}\n`), { turns: 1, lastTool: 'command_execution', tokens: 8, inputTokens: 10 })
})

const ws = { inputs: '/ws/in', outputs: '/ws/out', work: '/ws/work' } as never

test('the Claude Code Runtime asks for acceptEdits, allows Bash and the web tools, and denies git push and gh', () => {
  const { argv } = claudeInvocation('claude', ws, 'do it', 'token')
  const after = (flag: string) => {
    const rest = argv.slice(argv.indexOf(flag) + 1)
    const end = rest.findIndex((a) => a.startsWith('--'))
    return end < 0 ? rest : rest.slice(0, end)
  }
  assert.deepEqual(after('--permission-mode'), ['acceptEdits'])
  assert.deepEqual(after('--allowedTools'), ['Bash', 'WebSearch', 'WebFetch'])
  assert.deepEqual(after('--disallowedTools'), ['Bash(git push:*)', 'Bash(gh:*)'])
  assert.equal(argv.includes('--dangerously-skip-permissions'), false)
  assert.deepEqual(claudeInvocation('claude', ws, 'do it', 'token', undefined, true).argv.slice(-1), ['Monitor'])
})

const sbWs = { root: '/fake/home/.dsh/attempt', home: '/fake/home/.dsh/attempt/home', inputs: '/fake/home/.dsh/attempt/in', outputs: '/fake/home/.dsh/attempt/out', work: '/fake/home/.dsh/attempt/work' } as never
const fakeHost = { home: () => '/fake/home', gitCommonDir: () => '/fake/home/src/repo/.git' }
const sandboxed = (sandbox: unknown, codeWrite = false) => claude.invocation({ command: 'claude', ws: sbWs, prompt: 'p', codeWrite, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, sandbox: sandbox as never, host: fakeHost })
const settingsOf = (argv: string[]) => JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean; excludedCommands?: unknown; filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] }; network?: { allowedDomains?: string[] } } }

test('without the sandbox option the Claude Code argv has no --settings, and is what it was', () => {
  const plain = claude.invocation({ command: 'claude', ws: sbWs, prompt: 'p', codeWrite: false, env: {} })
  assert.equal(plain.argv.includes('--settings'), false)
  assert.deepEqual(claude.invocation({ command: 'claude', ws: sbWs, prompt: 'p', codeWrite: false, env: {}, host: fakeHost }), plain)
})

test('with the sandbox option the argv carries --settings: enabled, never fails open, the real home denied, the attempt\'s directories allowed', () => {
  const { argv } = sandboxed(true)
  const { sandbox } = settingsOf(argv)
  assert.equal(sandbox.enabled, true)
  assert.equal(sandbox.failIfUnavailable, true)
  assert.equal(sandbox.allowUnsandboxedCommands, false)
  assert.equal('excludedCommands' in sandbox, false)
  assert.deepEqual(sandbox.filesystem.denyRead, ['/fake/home'])
  for (const dir of ['/fake/home/.dsh/attempt/work', '/fake/home/.dsh/attempt/in', '/fake/home/.dsh/attempt/out', '/fake/home/.dsh/attempt/home', '/fake/home/src/repo/.git']) assert.ok(sandbox.filesystem.allowRead.includes(dir), dir)
  assert.deepEqual(sandbox.filesystem.allowWrite, ['/fake/home/.dsh/attempt/home', '/fake/home/.dsh/attempt/in', '/fake/home/.dsh/attempt/out'])
  // The rb-4 flags and the environment stay.
  assert.deepEqual(argv.slice(0, argv.indexOf('--settings')), claudeInvocation('claude', sbWs, 'p', 't').argv)
  assert.equal(sandboxed(true).env.GIT_SSH_COMMAND, claudeInvocation('claude', sbWs, 'p', 't').env.GIT_SSH_COMMAND)
})

test('the sandbox allows reading only what lies under the real home from PATH, the repository and the option; the network is the option\'s hosts, empty by default', () => {
  const home = '/fake/home'
  const { sandbox } = settingsOf(sandboxed({ allowRead: ['/fake/home/.cache/x', '/opt/elsewhere'], allowedDomains: ['registry.npmjs.org'] }).argv)
  assert.ok(sandbox.filesystem.allowRead.includes('/fake/home/.cache/x'))
  assert.ok(sandbox.filesystem.allowRead.includes('/opt/elsewhere'))
  assert.deepEqual(sandbox.network?.allowedDomains, ['registry.npmjs.org'])
  const bare = settingsOf(sandboxed(true).argv).sandbox
  assert.deepEqual(bare.network?.allowedDomains ?? [], [])
  // Only PATH entries under the home are added (the Node of baseEnv); an entry outside it is not.
  const dirs = baseEnv(sbWs).PATH!.split(':').filter((d) => d.startsWith(home + '/'))
  for (const d of dirs) assert.ok(bare.filesystem.allowRead.includes(d), d)
  assert.equal(bare.filesystem.allowRead.includes('/usr/bin'), false)
  // A repository outside the home is not listed.
  const outside = claude.invocation({ command: 'claude', ws: sbWs, prompt: 'p', codeWrite: false, env: {}, sandbox: true, host: { home: () => '/fake/home', gitCommonDir: () => '/srv/repo/.git' } })
  assert.equal(settingsOf(outside.argv).sandbox.filesystem.allowRead.includes('/srv/repo/.git'), false)
})

test('the real home comes from the passwd entry, not $HOME', () => {
  const real = claude.invocation({ command: 'claude', ws: sbWs, prompt: 'p', codeWrite: false, env: {}, sandbox: true })
  assert.deepEqual(settingsOf(real.argv).sandbox.filesystem.denyRead, [userInfo().homedir])
})

test('the sandbox option is refused on a Codex Account and checked for unknown keys and shapes', () => {
  assert.throws(() => codex.invocation({ command: 'codex', ws, prompt: 'p', codeWrite: false, env: {}, sandbox: true }), /Claude Code Runtime only/)
  assert.throws(() => checkSandbox('codex', true), /spike that covers the Claude Code Runtime only/)
  assert.throws(() => checkSandbox('web', true), /spike that covers the Claude Code Runtime only/)
  assert.throws(() => checkSandbox('claude-code', { allowWrite: ['/x'] }), /unknown key allowWrite/)
  assert.throws(() => checkSandbox('claude-code', { allowRead: ['relative'] }), /absolute/)
  assert.throws(() => checkSandbox('claude-code', false), /true or an object/)
  assert.equal(checkSandbox('claude-code', undefined), undefined)
  assert.equal(checkSandbox('codex', undefined), undefined)
  assert.equal(checkSandbox('claude-code', true), true)
})

test('the Codex Runtime runs in the workspace-write sandbox, never a wider one', () => {
  const { argv } = codexInvocation('codex', ws, 'do it', '/codex-home')
  assert.equal(argv[argv.indexOf('-s') + 1], 'workspace-write')
  assert.equal(argv.some((a) => /danger|bypass|read-only/.test(a)), false)
})

test('the registry is keyed by Runtime name: both CLI Runtimes have an adapter, `web` has none', () => {
  assert.equal(claude.runtime, 'claude-code')
  assert.equal(codex.runtime, 'codex')
  assert.equal(adapterFor('web'), undefined)
})

test('the credential of each adapter reaches the CLI only through its env', () => {
  assert.equal(claudeInvocation('claude', ws, 'p', 'tok').env.CLAUDE_CODE_OAUTH_TOKEN, 'tok')
  assert.equal(codexInvocation('codex', ws, 'p', '/h').env.CODEX_HOME, '/h')
})

test("an attempt's git over ssh is refused by GIT_SSH_COMMAND, without a network", () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-ssh-'))
  try {
    const env = baseEnv({ root: dir, home: dir, work: dir } as never)
    const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' })
    execFileSync('git', ['init', '--quiet', dir], { env })
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'x'], { env })
    git('remote', 'add', 'origin', 'ssh://git@example.invalid/x.git')
    for (const args of [['push', '--dry-run', 'origin', 'HEAD:refs/heads/x'], ['fetch', 'origin']]) {
      const got = git(...args)
      assert.notEqual(got.status, 0, args.join(' '))
      assert.match(got.stderr, /System gives a Worker no push access\./, args.join(' '))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
