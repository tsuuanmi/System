/**
 * Process and host stand-ins shared by tests: a `Spawner` with the DSH
 * subprocess contract (a process group, SIGTERM on abort, SIGKILL after the
 * grace).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { recordingPid, type Spawner } from '@system/agents'

/** How long a test's process may still be read after it exits: far over the default, so a loaded machine never closes the pipes before the output is read. */
const DRAIN_TEST_MS = 60_000

export const processSpawner: Spawner = {
  spawn(spec) {
    const argv = recordingPid(spec)
    const env = Object.fromEntries(Object.entries(spec.env).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv
    const child = spawn(argv[0]!, argv.slice(1), { cwd: spec.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    // A process that cannot start (a missing command or working directory) ends the attempt with its reason, as a failed exit; it never goes unheard.
    const failed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => child.on('error', (error) => {
      stderr += `${error.message}${spec.cwd && !existsSync(spec.cwd) ? ` (the working directory ${spec.cwd} does not exist)` : ''}\n`
      resolve({ exitCode: 127, signal: null })
    }))
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const group = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal) } catch { /* already gone */ } }
    spec.signal.addEventListener('abort', () => {
      group('SIGTERM')
      setTimeout(() => group('SIGKILL'), spec.graceMs).unref()
    }, { once: true })
    return {
      // The agent's exit ends the attempt: its output is drained for a bounded time, then the pipes are closed and what it left in its group is killed.
      done: Promise.race([failed, new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => child.on('exit', (exitCode, signal) => {
        const close = () => { child.stdout.destroy(); child.stderr.destroy(); group('SIGKILL'); resolve({ exitCode, signal }) }
        const drain = setTimeout(close, spec.drainMs ?? DRAIN_TEST_MS)
        child.on('close', () => { clearTimeout(drain); group('SIGKILL'); resolve({ exitCode, signal }) })
      }))]),
      stdout: () => stdout,
      stderr: () => stderr,
    }
  },
}
