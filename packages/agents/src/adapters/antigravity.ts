/** The Antigravity Runtime (`agy`): how its CLI is invoked, staged, read and measured (Item ag-2, RES-0015). */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { AttemptSummary, Progress } from '@system/work'
import { jsonEvents, unknownSummary } from '../attempt-summary.ts'
import { AGY_GROUPS, createQuotaCache, readAntigravityQuota, type AgyQuotaGroup } from '../quota.ts'
import { baseEnv, type Invocation, type Parsed } from '../runtimes.ts'
import { applyFinalResult, FINAL_RESULT_SCHEMA } from './final-result.ts'
import type { CliAdapter, InvocationInput, ParseOptions } from './types.ts'

/** Where `agy` reads its login and its permission rules, under the Account's HOME. */
const CONFIG = ['.gemini', 'antigravity-cli'] as const
const TOKEN = 'antigravity-oauth-token'
/**
 * Headless permissions are file rules, not flags: without an allow rule a shell command is auto-denied. Deny wins; `command(git push:*)` and
 * `command(gh *)` do not match, these exact forms do (verified on agy 1.5.18). System owns this file and writes it before each attempt.
 */
const SETTINGS = `${JSON.stringify({ permissions: { allow: ['command(*)'], deny: ['command(git push)', 'command(gh)'] } }, null, 2)}\n`

const MODE = 'accept-edits'

/**
 * `cwd` is the checkout (agy has no cwd flag) and HOME the attempt's throwaway `ws.home` (with `.gemini` linked to `agyHome/.gemini`);
 * `--mode auto` is refused for these Accounts, so `accept-edits`; never `--dangerously-skip-permissions`. The session bus is never passed
 * (baseEnv has none), so the token is read from a file.
 */
function invocation({ command, ws, prompt, model, env }: InvocationInput): Invocation {
  return {
    argv: [command, '-p', prompt, '--output-format', 'stream-json', ...(model ? ['--model', model] : []), '--mode', MODE, '--sandbox', '--add-dir', ws.inputs, '--add-dir', ws.outputs, '--json-schema', FINAL_RESULT_SCHEMA],
    env: { ...baseEnv(ws), ...env },
    // The settings bytes `writeSettings` stages are SETTINGS.
    scope: { permissionMode: MODE, sandbox: true, settingsSha256: createHash('sha256').update(SETTINGS).digest('hex') },
  }
}

const count = (value: unknown) => (Number.isInteger(value) ? (value as number) : undefined)
/** The error text of a failed run; a quota error is worded so the controller records the attempt as limited (work/limits.ts), keeping its reset time. */
const QUOTA = /RESOURCE_EXHAUSTED|\bquota\b|exhausted your capacity/i
const LIMITED = /rate.?limit|too many requests|\b429\b|quota exceeded/i
const failureText = (error: string) => (QUOTA.test(error) && !LIMITED.test(error) ? `quota exceeded: ${error}` : error)

/** The `result` event decides: SUCCESS is ok; a tool that ended in ERROR (a denied `git push`) is only a step of the run, and so are denied actions when the run still answered (without a response they fail the attempt, since headless mode cannot prompt). Its usage is the run's total. */
function parse(stdout: string, options?: ParseOptions): Parsed {
  const result = jsonEvents(stdout).findLast((event) => event.event === 'result')?.result
  if (!result) return { ok: false, message: `unreadable Antigravity output: ${stdout.slice(0, 200)}`, usageGap: 'antigravity printed no result event' }
  if (result.status !== 'SUCCESS') return { ok: false, message: failureText(String(result.error ?? result.response ?? result.status)), usageGap: `the antigravity run ended ${String(result.status)} without usage counts` }
  const denied: string[] = Array.isArray(result.denied_actions) ? result.denied_actions.map((d: any) => String(d?.action ?? d?.display_name ?? 'unknown')) : []
  if (denied.length > 0 && !String(result.response ?? '').trim()) {
    return { ok: false, message: `agy denied ${[...new Set(denied)].join(', ')} (headless mode cannot prompt) and ended with no response` }
  }
  const u = result.usage ?? {}
  const input = count(u.input_tokens)
  const output = count(u.output_tokens)
  const cached = count(u.cache_read_tokens)
  const usage = input === undefined || output === undefined ? undefined : {
    inputTokens: input + (cached ?? 0),
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    outputTokens: output,
    source: 'antigravity result usage over the run (input_tokens is fresh; inputTokens adds cache_read_tokens)',
  }
  const response = String(result.response ?? '').trimEnd()
  const base: Parsed = { ok: true, message: response, usage, ...(usage ? {} : { usageGap: 'the antigravity result carried no input and output token counts' }) }
  if (options?.structured === false) return base
  // agy 1.5.18 puts the schema-shaped JSON in the last `agent_response` step and a prose summary in `result.response`.
  const stepText = lastAgentResponse(stdout)
  const structured = stepText !== undefined && isJson(stepText) ? stepText : response
  return applyFinalResult(base, structured.trim() ? structured : undefined)
}

const isJson = (text: string) => { try { JSON.parse(text); return true } catch { return false } }

/** The accumulated `text_delta` of the last `agent_response` step (all events with its `step_index`), or undefined when there is none. */
function lastAgentResponse(stdout: string): string | undefined {
  let index: unknown
  let text = ''
  for (const { step_update: step } of jsonEvents(stdout)) {
    if (step?.step_type !== 'agent_response') continue
    if (step.step_index !== index) { index = step.step_index; text = '' }
    if (typeof step.text_delta === 'string') text += step.text_delta
  }
  return index === undefined ? undefined : text.trim()
}

/** Progress as the stream grows: a turn is a finished agent response with usage, the last tool the last tool step. */
function progress(): (stdout: string) => Progress {
  let consumed = 0
  let turns = 0
  let tokens = 0
  let input = 0
  let lastTool: string | undefined
  const n = (value: unknown) => count(value) ?? 0
  return (stdout) => {
    const end = stdout.lastIndexOf('\n') + 1
    for (const line of stdout.slice(consumed, Math.max(consumed, end)).split('\n')) {
      let step: any
      try { step = JSON.parse(line)?.step_update } catch { continue }
      if (step?.step_type === 'agent_response' && step.state === 'DONE' && step.usage) {
        turns += 1
        tokens += n(step.usage.input_tokens) + n(step.usage.output_tokens)
        input += n(step.usage.input_tokens) + n(step.usage.cache_read_tokens)
      }
      if (step?.step_type === 'tool' && typeof step.tool_name === 'string') lastTool = step.tool_name
    }
    consumed = Math.max(consumed, end)
    return { turns, ...(lastTool ? { lastTool } : {}), tokens, inputTokens: input }
  }
}

/** The stream says its tool calls by name (each step once, at its end); everything else is unknown. */
function summarize(output: string): AttemptSummary {
  const toolCalls: Record<string, number> = {}
  for (const { step_update: step } of jsonEvents(output)) {
    if (step?.step_type === 'tool' && step.state !== 'ACTIVE' && typeof step.tool_name === 'string') toolCalls[step.tool_name] = (toolCalls[step.tool_name] ?? 0) + 1
  }
  return { ...unknownSummary('antigravity'), toolCalls }
}

/** Write the permission rules into the Account's home: same bytes every time, renamed into place so attempts sharing the home never see half a file. */
function writeSettings(home: string): void {
  const dir = join(home, ...CONFIG)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const staged = join(dir, `.settings.json.${process.pid}.${Math.random().toString(16).slice(2)}`)
  writeFileSync(staged, SETTINGS)
  renameSync(staged, join(dir, 'settings.json'))
}

export const antigravity: CliAdapter = {
  runtime: 'antigravity',
  defaultCommand: 'agy',
  async preflight(account) {
    const home = account.agyHome
    if (!home) return { failed: `${account.ref}: no agyHome (the Account home holding .gemini/antigravity-cli)` }
    return {
      stage(dir) {
        writeSettings(home)
        // Run with the attempt's throwaway HOME so caches/stores do not accumulate in agyHome; only `.gemini` is linked to the Account's state.
        const attemptHome = join(dir, 'home')
        mkdirSync(attemptHome, { recursive: true, mode: 0o700 })
        const link = join(attemptHome, '.gemini')
        rmSync(link, { recursive: true, force: true })
        symlinkSync(resolve(home, '.gemini'), link)
        return { env: {}, finish() {} }
      },
    }
  },
  invocation,
  // agy has no verified way to run a turn without tools, and the staged rules allow every command: no Classifier question runs on it.
  askArgv: () => { throw new Error('the antigravity Runtime does not answer a question without tools') },
  parse,
  progress,
  summarize,
  // System never reads the token: `agy` does, from the Account's home.
  accountId: () => undefined,
  async register({ account, resolved, command, home, quota }) {
    const group = account.quotaGroup
    if (group !== 'gemini' && group !== '3p') throw new Error(`quotaGroup must be one of ${Object.keys(AGY_GROUPS).join(', ')}`)
    const dir = account.agyHome ?? `antigravity/${account.ref.split('/')[1] ?? 'default'}`
    const agyHome = (resolved.agyHome = isAbsolute(dir) ? dir : home(dir))
    resolved.quotaGroup = group
    if (!existsSync(join(agyHome, ...CONFIG, TOKEN))) throw new Error(`no login in ${agyHome} (HOME=${agyHome} agy, then sign in)`)
    return { quota: createQuotaCache({ ...quota, read: () => readAntigravityQuota({ command, home: agyHome, group: group as AgyQuotaGroup, now: quota.now }) }) }
  },
}
