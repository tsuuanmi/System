/** ACP v1 transport using the official TypeScript SDK and DSH's subprocess seam.
 * The ACP wire protocol is owned by @agentclientprotocol/sdk, not System.
 * Work, Artifact, approval and verification authority remain with System.
 */
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { SubprocessRuntime, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { recordingPid } from '@system/worker-execution'

const EOF_GRACE_MS = 6_000
const TERMINATE_GRACE_MS = 3_000
const MAX_EVENTS = 64

export interface AcpRunInput {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  prompt: string
  signal: AbortSignal
  pidFile: string
  onStage?: (stage: string) => void
}

export interface AcpRunResult {
  stopReason: string
  permissionDenied: boolean
  events: string[]
  exitCode: number | null
}

export interface AcpRunner {
  run(input: AcpRunInput): Promise<AcpRunResult>
}

/** Dispose of a DSH-managed process group; never confuse protocol completion with exit proof. */
async function quiesce(child: SubprocessHandle): Promise<{ exitCode: number | null }> {
  child.stdin?.end()
  let exited = false
  try {
    exited = await child.waitForExit(AbortSignal.timeout(EOF_GRACE_MS))
  } catch { /* provider errors still require an attempted termination */ }
  if (!exited) {
    child.terminate()
    // DSH owns the SIGTERM/SIGKILL escalation and whole-range observation.
    await child.waitForExit()
  }
  const outcome = await child.done
  return { exitCode: outcome.exitCode }
}

/** SDK-driven ACP v1 client; one isolated ACP session per System Attempt. */
export function dshAcpRunner(subprocess: SubprocessRuntime): AcpRunner {
  return {
    async run(input) {
      if (input.signal.aborted) throw new Error('ACP attempt was cancelled before spawn')
      const log: string[] = []
      const stage = (name: string) => {
        try { input.onStage?.(name) } catch { /* reporting must not stop the protocol */ }
        if (log.length < MAX_EVENTS) log.push(JSON.stringify({ type: 'acp.stage', stage: name }))
      }
      let denied = false
      let remoteCancel: (() => void) | undefined
      const command = recordingPid({
        argv: [input.command, ...input.args], cwd: input.cwd, env: input.env,
        signal: input.signal, graceMs: TERMINATE_GRACE_MS, pidFile: input.pidFile,
      })
      const child = subprocess.spawn({
        argv: command,
        cwd: input.cwd,
        env: input.env,
        signal: input.signal,
        graceMs: TERMINATE_GRACE_MS,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      })
      const onAbort = () => { remoteCancel?.(); child.terminate() }
      input.signal.addEventListener('abort', onAbort, { once: true })
      if (input.signal.aborted) onAbort()
      let stopReason: string | undefined
      let completed = false
      let remoteAbortWait: (() => void) | undefined
      // DSH's ACP client uses only *rejected* process outcomes for the RPC
      // race: a clean child exit must not beat an already delivered ACP reply.
      // EOF on the SDK pipe and the Attempt deadline settle the other cases.
      const processFailed: Promise<never> = child.done.then(
        () => new Promise<never>(() => {}),
        () => { throw new Error('ACP child process failed') },
      )
      void processFailed.catch(() => {})
      try {
        if (!child.stdin || !child.stdout) throw new Error('ACP process needs bidirectional pipes')
        const app = client({ name: 'system-worker-acp' })
          .onNotification(methods.client.session.update, ({ params }) => {
            const kind = params.update.sessionUpdate
            if (kind === 'agent_message_chunk') stage('agent_message')
            else if (kind === 'tool_call' || kind === 'tool_call_update') stage('tool')
            return Promise.resolve()
          })
          .onRequest(methods.client.session.requestPermission, () => {
            denied = true
            stage('permission_denied')
            return Promise.resolve({ outcome: { outcome: 'cancelled' as const } })
          })
        const connection = app.connect(ndJsonStream(
          NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ))
        const agent = connection.agent
        let abortWait: (() => void) | undefined
        const aborted = new Promise<never>((_, reject) => {
          abortWait = () => reject(new Error('ACP request cancelled'))
          if (input.signal.aborted) abortWait()
          else input.signal.addEventListener('abort', abortWait, { once: true })
        })
        // The listener is cleared in the enclosing finally; the signal dies
        // with the Attempt, not with the ACP subprocess.
        remoteAbortWait = abortWait
        const request = <T>(promise: Promise<T>): Promise<T> =>
          Promise.race([promise, processFailed, aborted])
        await request(agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }))
        stage('initialized')
        const session = await request(agent.request(methods.agent.session.new, {
          cwd: input.cwd,
          mcpServers: [],
        }))
        if (typeof session.sessionId !== 'string' || !session.sessionId) {
          throw new Error('ACP agent did not return a session id')
        }
        remoteCancel = () => {
          void agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId }).catch(() => {})
        }
        stage('session_ready')
        const result = await request(agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: input.prompt }],
        }))
        stopReason = result.stopReason
        completed = true
        stage('turn_finished')
      } finally {
        input.signal.removeEventListener('abort', onAbort)
        if (remoteAbortWait) input.signal.removeEventListener('abort', remoteAbortWait)
        // Only a reaped process permits its PID marker to be cleared by owner.
        // A teardown failure leaves the marker for System recovery.
        try {
          const outcome = await quiesce(child)
          if (completed && outcome.exitCode !== 0) {
            throw new Error('ACP child exited with an error after the prompt')
          }
          const { rmSync } = await import('node:fs')
          rmSync(input.pidFile, { force: true })
        } catch (error) {
          stage('teardown_failed')
          throw error
        }
      }
      if (stopReason === undefined) throw new Error('ACP turn has no stop reason')
      return { stopReason, permissionDenied: denied, events: log, exitCode: 0 }
    },
  }
}
