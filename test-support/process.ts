/**
 * Process and host stand-ins shared by tests: a `Spawner` with the DSH
 * subprocess contract (a process group, SIGTERM on abort, SIGKILL after the
 * grace).
 */
import { spawn } from 'node:child_process'
import type { Spawner } from '@system/agents'

export const processSpawner: Spawner = {
  spawn(spec) {
    const env = Object.fromEntries(Object.entries(spec.env).filter(([, value]) => value !== undefined)) as NodeJS.ProcessEnv
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const group = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal) } catch { /* already gone */ } }
    spec.signal.addEventListener('abort', () => {
      group('SIGTERM')
      setTimeout(() => group('SIGKILL'), spec.graceMs).unref()
    }, { once: true })
    return {
      done: new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))),
      stdout: () => stdout,
      stderr: () => stderr,
    }
  },
}
