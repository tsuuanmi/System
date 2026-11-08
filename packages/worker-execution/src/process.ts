/** DSH-owned process supervision, identity and version discovery.
 * No Worker provider or Work Controller policy lives here. */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export interface SpawnSpec {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
  signal: AbortSignal
  graceMs: number
  pidFile?: string
}

export interface Spawned {
  done: Promise<{ exitCode: number | null; signal: string | null }>
  stdout(): string
  stderr(): string
}

export interface Spawner {
  spawn(spec: SpawnSpec): Spawned
}

/** PID recorded before exec, for Host recovery when its process was lost. */
export function recordingPid(spec: SpawnSpec): string[] {
  return spec.pidFile ? ['/bin/sh', '-c', 'echo $$ > "$1" && shift && unset PWD && exec "$@"', 'sh', spec.pidFile, ...spec.argv] : spec.argv
}

export const pidFile = (attemptsDir: string, attemptId: string) =>
  join(attemptsDir, `${attemptId.replace(/[^a-z0-9-]/gi, '_')}.pid`)

export function exited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export function goneFromPidFile(attemptsDir: string, attemptId: string): boolean {
  const file = pidFile(attemptsDir, attemptId)
  if (!existsSync(file)) return true
  const pid = Number(readFileSync(file, 'utf8'))
  if (Number.isInteger(pid) && pid > 0 && !exited(pid)) return false
  rmSync(file, { force: true })
  return true
}

/** The DSH subprocess service owns the whole process group and its termination. */
export function subprocessSpawner(subprocess: SubprocessRuntime): Spawner {
  return {
    spawn(spec) {
      const handle = subprocess.spawn({
        argv: recordingPid(spec), cwd: spec.cwd, env: spec.env, signal: spec.signal, graceMs: spec.graceMs,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      })
      return {
        done: handle.done.then(async (outcome) => {
          await handle.waitForExit().catch(() => false)
          return { exitCode: outcome.exitCode, signal: outcome.signal }
        }),
        stdout: () => handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: () => handle.collected.stderr?.readFrom(0).text ?? '',
      }
    },
  }
}

/** Ask CLI --version once only, and never spawn during Host startup. */
export function lazyVersion(subprocess: SubprocessRuntime, command: string): () => Promise<string> {
  let asked: Promise<string> | undefined
  return () => {
    asked ??= (async () => {
      try {
        const handle = subprocess.spawn({
          argv: [command, '--version'], cwd: process.cwd(), graceMs: 2000,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        })
        await handle.done
        return (handle.collected.stdout?.readFrom(0).text ?? '').trim().split('\n')[0] ?? ''
      } catch {
        return ''
      }
    })()
    return asked
  }
}
