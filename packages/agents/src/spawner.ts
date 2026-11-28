/** The DSH subprocess service as the Spawner the agents use, and the lazy `--version` ask (ADR-0017: part of the `./contract`). */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { DRAIN_MS, recordingPid, type Spawner } from './agent.ts'

/** A `Spawner` over the DSH subprocess service, which owns each process range. */
export function subprocessSpawner(subprocess: SubprocessRuntime): Spawner {
  return {
    spawn(spec) {
      const handle = subprocess.spawn({
        argv: recordingPid(spec), cwd: spec.cwd, env: spec.env, signal: spec.signal, graceMs: spec.graceMs,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      })
      return {
        // The agent's exit ends the attempt. Its range gets a bounded time to empty (and its output to arrive); what a leaked
        // process (an Xvfb of its own tests) still holds after that is terminated, never waited for: 33 min on 2026-11-07.
        done: handle.done.then(async (outcome) => {
          const drained = await handle.waitForExit(AbortSignal.timeout(spec.drainMs ?? DRAIN_MS)).catch(() => false)
          if (!drained) handle.terminate()
          return { exitCode: outcome.exitCode, signal: outcome.signal }
        }),
        stdout: () => handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: () => handle.collected.stderr?.readFrom(0).text ?? '',
      }
    },
  }
}

/** `<command> --version`, spawned once, on first use: startup spawns nothing. */
export function lazyVersion(subprocess: SubprocessRuntime, command: string): () => Promise<string> {
  let asked: Promise<string> | undefined
  return () => {
    asked ??= (async () => {
      try {
        const handle = subprocess.spawn({ argv: [command, '--version'], cwd: process.cwd(), graceMs: 2000, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
        await handle.done
        return (handle.collected.stdout?.readFrom(0).text ?? '').trim().split('\n')[0] ?? ''
      } catch {
        // A managed Chrome that is not installed yet has no version to report.
        return ''
      }
    })()
    return asked
  }
}
