/**
 * Driving the real `bin/system` from smoke tests: one throwaway DSH home per
 * test file, a runner bound to it, and the Host (`bin/system host`) that every
 * Work command talks to.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION, connect } from '../packages/host/src/index.ts'

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const fakeAgent = join(repo, 'packages', 'agents', 'tests', 'fake-agent.mjs')

export interface Ran {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** A `bin/system host` child process serving one home. */
export interface RunningHost {
  child: ChildProcess
  stderr(): string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** SIGTERM, then SIGKILL if it has not exited after ten seconds. */
  stop(): Promise<void>
}

/** A `bin/system` command running beside the test. */
export interface Running {
  child: ChildProcess
  stdout(): string
  stderr(): string
  done: Promise<Ran>
}

export interface SystemCli {
  home: string
  env: NodeJS.ProcessEnv
  /** `$DSH_HOME/system/host.sock`. */
  socket: string
  /** Run `bin/system <args>`; `input` is piped to stdin. */
  run(args: string[], options?: { input?: string; env?: Record<string, string>; timeoutMs?: number }): Ran
  /** Run `bin/system <args>` without waiting for it. */
  runAsync(args: string[], options?: { env?: Record<string, string> }): Running
  /**
   * Start the Host of this home, with `env` added, and wait for its socket.
   * A Host this started before is stopped first: one Host per home.
   */
  start(options?: { env?: Record<string, string>; args?: string[] }): Promise<RunningHost>
  /** The process ID of the Host that answers on the socket: what a test kills to crash it. */
  pid(): Promise<number>
  /** Stop every Host this started. Call it from `after`. */
  stop(): Promise<void>
}

/**
 * A throwaway DSH home (or `home`, such as the operator's own) and a runner for it.
 * A socket path is limited to about 100 bytes, and tmpdir() may be longer.
 */
export function systemCli(prefix: string, base: Record<string, string> = { SYSTEM_OPERATOR_ID: 'tester', SYSTEM_CALLER: 'human' }, home = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), `${prefix}-`))): SystemCli {
  const env = { ...process.env, DSH_HOME: home, ...base }
  const socket = join(home, 'system', 'host.sock')
  const hosts: RunningHost[] = []
  const entry = join(repo, 'bin', 'system')

  async function stop(): Promise<void> {
    await Promise.all(hosts.splice(0).map((host) => host.stop()))
  }

  return {
    home,
    env,
    socket,
    run(args, options = {}) {
      const ran = spawnSync(process.execPath, [entry, ...args], {
        env: { ...env, ...options.env }, input: options.input, encoding: 'utf8', timeout: options.timeoutMs ?? 180_000,
      })
      return { status: ran.status, signal: ran.signal, stdout: ran.stdout, stderr: ran.stderr }
    },
    runAsync(args, options = {}) {
      const child = spawn(process.execPath, [entry, ...args], { env: { ...env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout!.on('data', (d) => { stdout += d })
      child.stderr!.on('data', (d) => { stderr += d })
      const done = new Promise<Ran>((resolve) => child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr })))
      return { child, stdout: () => stdout, stderr: () => stderr, done }
    },
    async start(options = {}) {
      await stop()
      const child = spawn(process.execPath, [entry, ...(options.args ?? []), 'host'], { env: { ...env, ...options.env }, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr!.on('data', (d) => { stderr += d })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
      const host: RunningHost = {
        child,
        stderr: () => stderr,
        exited,
        stop: () => {
          if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
          const force = setTimeout(() => child.kill('SIGKILL'), 10_000)
          child.kill('SIGTERM')
          return exited.then(() => clearTimeout(force))
        },
      }
      hosts.push(host)
      // The Host says when it listens; waiting for that line, not for a number of tries, holds at any load.
      await new Promise<void>((resolve, reject) => {
        const heard = () => {
          if (!/listening on /.test(stderr)) return
          child.stderr!.off('data', heard)
          resolve()
        }
        child.stderr!.on('data', heard)
        heard()
        void exited.then(() => reject(new Error(`the Host exited before answering: ${stderr}`)))
      })
      return host
    },
    async pid() {
      const client = await connect(socket)
      try {
        await client.call('host.hello', { version: VERSION, caller: { type: 'human', operatorId: 'tester' } })
        return ((await client.call('host.status')) as { pid: number }).pid
      } finally {
        client.close()
      }
    },
    stop,
  }
}
