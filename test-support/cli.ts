/**
 * Driving the real `bin/system` from smoke tests: one throwaway DSH home per
 * test file and a runner bound to it.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const fakeAgent = join(repo, 'packages', 'agents', 'tests', 'fake-agent.mjs')

export interface Ran {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface SystemCli {
  home: string
  env: NodeJS.ProcessEnv
  /** Run `bin/system <args>`; `input` is piped to stdin. */
  run(args: string[], options?: { input?: string; env?: Record<string, string>; timeoutMs?: number }): Ran
}

/** A throwaway DSH home (or `home`, such as the operator's own) and a runner for it. */
export function systemCli(prefix: string, base: Record<string, string> = { SYSTEM_OPERATOR_ID: 'tester', SYSTEM_CALLER: 'human' }, home = mkdtempSync(join(tmpdir(), `${prefix}-`))): SystemCli {
  const env = { ...process.env, DSH_HOME: home, ...base }
  return {
    home,
    env,
    run(args, options = {}) {
      const ran = spawnSync(process.execPath, [join(repo, 'bin', 'system'), ...args], {
        env: { ...env, ...options.env }, input: options.input, encoding: 'utf8', timeout: options.timeoutMs ?? 180_000,
      })
      return { status: ran.status, signal: ran.signal, stdout: ran.stdout, stderr: ran.stderr }
    },
  }
}
