/** The Codex Runtime: how its CLI is invoked, staged, read and measured (ADR-0005). */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { AttemptSummary, Progress } from '@system/work'
import { jsonEvents, unknownSummary } from '../attempt-summary.ts'
import { createQuotaCache, readCodexQuota } from '../quota.ts'
import { baseEnv, type Invocation, type Parsed } from '../runtimes.ts'
import { readCodexAccountId } from '../identity.ts'
import type { CliAdapter, InvocationInput } from './types.ts'

function invocation({ command, ws, prompt, model, env }: InvocationInput): Invocation {
  return {
    argv: [
      command, 'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      ...(model ? ['-m', model] : []),
      '-s', 'workspace-write', '-C', ws.work, '--add-dir', ws.outputs, prompt,
    ],
    env: { ...baseEnv(ws), ...env },
  }
}

function parse(stdout: string): Parsed {
  let input = 0
  let cached = 0
  let output = 0
  let turns = 0
  /** A turn without both counts makes the total unknown, never a partial sum. */
  let counted = true
  /** Cache reads are known only if every turn reported them. */
  let split = true
  let failure: string | undefined
  let message = ''
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event: { type?: string; usage?: Record<string, number>; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'turn.completed') {
      turns += 1
      const u = event.usage
      if (u && Number.isInteger(u.input_tokens) && Number.isInteger(u.output_tokens)) {
        input += u.input_tokens!
        output += u.output_tokens!
        if (Number.isInteger(u.cached_input_tokens)) cached += u.cached_input_tokens!
        else split = false
      } else {
        counted = false
      }
    }
    if (event.type === 'turn.failed' || event.type === 'error') failure = event.error?.message ?? event.message ?? event.type
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text ?? message
  }
  return {
    ok: turns > 0 && failure === undefined,
    message: failure ?? message,
    usage: turns && counted
      ? {
          inputTokens: input,
          ...(split ? { cacheReadTokens: cached } : {}),
          outputTokens: output,
          source: `codex turn.completed usage over ${turns} turn(s) (input_tokens includes cached_input_tokens)`,
        }
      : undefined,
  }
}

/** Progress as the stream grows (see Claude Code's): a turn is a `turn.completed`, the last tool the type of the last item completed. */
function progress(): (stdout: string) => Progress {
  let consumed = 0
  let turns = 0
  let tokens = 0
  let input = 0
  let lastTool: string | undefined
  const n = (value: unknown) => (Number.isInteger(value) ? (value as number) : 0)
  return (stdout) => {
    const end = stdout.lastIndexOf('\n') + 1
    for (const line of stdout.slice(consumed, Math.max(consumed, end)).split('\n')) {
      let event: any
      try { event = JSON.parse(line) } catch { continue }
      if (event?.type === 'turn.completed') {
        turns += 1
        tokens += n(event.usage?.input_tokens) - n(event.usage?.cached_input_tokens) + n(event.usage?.output_tokens)
        input += n(event.usage?.input_tokens)
      }
      if (event?.type === 'item.completed' && typeof event.item?.type === 'string' && event.item.type !== 'agent_message') lastTool = event.item.type
    }
    consumed = Math.max(consumed, end)
    return { turns, ...(lastTool ? { lastTool } : {}), tokens, inputTokens: input }
  }
}

/** Codex's log says only its command executions; everything else is unknown. */
function summarize(output: string): AttemptSummary {
  const toolCalls: Record<string, number> = {}
  for (const event of jsonEvents(output)) {
    if (event.type === 'item.completed' && event.item?.type === 'command_execution') toolCalls.command_execution = (toolCalls.command_execution ?? 0) + 1
  }
  return { ...unknownSummary('codex'), toolCalls }
}

const digest = (path: string) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '')

/** Copy a refreshed `auth.json` back, unless the account's file changed meanwhile. */
export function keepRefreshedAuth(auth: { attempt: string; account: string; before: string }): void {
  if (!existsSync(auth.attempt) || digest(auth.attempt) === auth.before || digest(auth.account) !== auth.before) return
  const staged = join(dirname(auth.account), `.auth.json.${process.pid}`)
  copyFileSync(auth.attempt, staged)
  renameSync(staged, auth.account)
}

export const codex: CliAdapter = {
  runtime: 'codex',
  defaultCommand: 'codex',
  async preflight(account) {
    const source = join(account.codexHome ?? '', 'auth.json')
    if (!existsSync(source)) return { failed: `${account.ref}: no auth.json in ${account.codexHome} (codex login --device-auth)` }
    return {
      stage(dir) {
        const home = join(dir, 'codex-home')
        mkdirSync(home, { mode: 0o700 })
        // A fresh CODEX_HOME per attempt holding only auth.json: no memories or history carry over (ADR-0005).
        copyFileSync(source, join(home, 'auth.json'))
        const auth = { attempt: join(home, 'auth.json'), account: source, before: digest(source) }
        return { env: { CODEX_HOME: home }, finish: () => keepRefreshedAuth(auth) }
      },
    }
  },
  invocation,
  askArgv: ({ command, prompt, model, work }) => [command, 'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-m', model, '-s', 'read-only', '-C', work, prompt],
  parse,
  progress,
  summarize,
  accountId: readCodexAccountId,
  async register({ account, resolved, command, home, quota }) {
    const dir = account.codexHome ?? `codex/${account.ref.split('/')[1] ?? 'default'}`
    const codexHome = (resolved.codexHome = isAbsolute(dir) ? dir : home(dir))
    if (!existsSync(join(codexHome, 'auth.json'))) throw new Error(`no auth.json in ${codexHome} (CODEX_HOME=${codexHome} codex login --device-auth)`)
    return { quota: createQuotaCache({ ...quota, read: () => readCodexQuota({ command, codexHome, now: quota.now }) }), providerAccount: readCodexAccountId(codexHome) }
  },
}
