/**
 * Process and host stand-ins shared by tests: a `Spawner` with the DSH
 * subprocess contract (a process group, SIGTERM on abort, SIGKILL after the
 * grace) and a `HostControl` for a single process.
 */
import { spawn } from 'node:child_process'
import type { Spawner } from '@system/agents'
import { WorkError, type CancelRequest, type HostControl } from '@system/work'

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

/** One process, no other host: a concurrent run in this process holds the Work. */
export class LocalControl implements HostControl {
  private readonly held = new Set<string>()
  private readonly cancels = new Map<string, CancelRequest>()

  acquire(workId: string): () => void {
    if (this.held.has(workId)) throw new WorkError(`${workId} is already being run`)
    this.held.add(workId)
    return () => { this.held.delete(workId) }
  }

  heldElsewhere(workId: string): boolean {
    return this.held.has(workId)
  }

  requestCancel(workId: string, request: CancelRequest): void {
    this.cancels.set(workId, request)
  }

  cancelRequest(workId: string): CancelRequest | undefined {
    return this.cancels.get(workId)
  }

  clearCancel(workId: string): void {
    this.cancels.delete(workId)
  }
}
