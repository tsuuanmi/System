/**
 * One model turn with no tools (cls-1), through the same Runtime machinery as an attempt: the CLI's invocation, the
 * `Spawner`, the account's own credential and the parsers of its output. It is the shape of ss-5's quota probe (a
 * single economy turn in an empty directory) with the answer kept. It never throws: a turn that cannot answer is a refusal.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tier } from '@system/work'
import { adapterFor } from './adapters/index.ts'
import type { Account, Spawner } from './agent.ts'
import { GIT_SSH_REFUSAL } from './runtimes.ts'

/** A turn's answer, or why there is none. */
export type Asked =
  | { ok: true; text: string; ref: string; runtime: string; model?: string; runtimeVersion: string }
  | { ok: false; reason: string }

/** Ask one question: a prompt in, the answer text out, never on an Account in `exclude`. */
export type Ask = (prompt: string, options: { exclude: string[]; tier?: Tier; signal?: AbortSignal }) => Promise<Asked>

/** A turn is short; past this it is stopped and refused. */
const TURN_TIMEOUT_MS = 120_000
const GRACE_MS = 5000
const KEEP = ['PATH', 'LANG', 'LC_ALL', 'TZ']

/** One turn on `account` at `tier` (default economy): no tools, an empty working directory, a throwaway HOME. */
export async function askAccount(account: Account, spawner: Spawner, root: string, prompt: string, options: { tier?: Tier; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Asked> {
  const tier = options.tier ?? 'economy'
  const model = account.models?.[tier]
  if (!model) return { ok: false, reason: `${account.ref} has no ${tier} model` }
  const adapter = adapterFor(account.runtime)!
  let dir: string | undefined
  try {
    const pre = await adapter.preflight(account)
    if ('failed' in pre) return { ok: false, reason: pre.failed }
    mkdirSync(root, { recursive: true })
    dir = mkdtempSync(join(root, 'ask-'))
    const work = join(dir, 'work')
    const home = join(dir, 'home')
    mkdirSync(work)
    mkdirSync(home, { mode: 0o700 })
    const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]))
    for (const key of KEEP) if (process.env[key]) env[key] = process.env[key]
    env.HOME = home
    env.TMPDIR = home
    env.GIT_SSH_COMMAND = GIT_SSH_REFUSAL
    const staged = pre.stage(dir)
    Object.assign(env, staged.env)
    const argv = adapter.askArgv({ command: account.command, prompt, model, work })
    const stop = new AbortController()
    const forward = () => stop.abort()
    if (options.signal?.aborted) forward()
    options.signal?.addEventListener('abort', forward, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; forward() }, options.timeoutMs ?? TURN_TIMEOUT_MS)
    const spawned = spawner.spawn({ argv, cwd: work, env, signal: stop.signal, graceMs: GRACE_MS })
    const outcome = await spawned.done.finally(() => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', forward)
    })
    const stdout = spawned.stdout()
    const events = adapter.rateLimitEvents?.(stdout)
    if (events?.length && account.onRateLimit) try { account.onRateLimit(events) } catch { /* a bad hook cannot fail the turn */ }
    const parsed = adapter.parse(stdout, { structured: false })
    staged.finish()
    if (timedOut) return { ok: false, reason: `${account.ref}: the turn timed out` }
    if (stop.signal.aborted) return { ok: false, reason: `${account.ref}: the turn was stopped` }
    if (outcome.exitCode !== 0 || !parsed.ok) {
      const why = outcome.signal ? `signal ${outcome.signal}` : `exit ${outcome.exitCode}`
      return { ok: false, reason: `${account.ref} ${why}: ${(parsed.message || spawned.stderr()).slice(0, 500)}` }
    }
    return { ok: true, text: parsed.message, ref: account.ref, runtime: account.runtime, model, runtimeVersion: await account.version() }
  } catch (error) {
    return { ok: false, reason: `${account.ref}: ${String((error as Error).message).slice(0, 300)}` }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

/** An `Ask` over the Accounts `accounts()` lists: the first that offers the tier and is not excluded; the next when it refuses. */
export function chooseAsker(accounts: () => readonly Account[], spawner: Spawner, root: string): Ask {
  return async (prompt, options) => {
    const tier = options.tier ?? 'economy'
    const candidates = accounts().filter((a) => a.models?.[tier] && !options.exclude.includes(a.ref))
    if (candidates.length === 0) return { ok: false, reason: `no Account offers the ${tier} tier${options.exclude.length ? ` besides ${options.exclude.join(', ')}` : ''}` }
    const reasons: string[] = []
    for (const account of candidates) {
      const got = await askAccount(account, spawner, root, prompt, { tier, signal: options.signal })
      if (got.ok) return got
      reasons.push(got.reason)
    }
    return { ok: false, reason: reasons.join('; ') }
  }
}
