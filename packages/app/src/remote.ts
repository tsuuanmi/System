/**
 * The Host client: the one module that knows how to call the Host. A call is
 * `call(method, params)` with a method of the operation table (see the API
 * reference of @system/host); the table says whether it only reads and whether
 * it takes a `commandId`, so the CLI and `system mcp` reach the Host by the same
 * policy and a new row needs no mapping here. A read goes over the session (while
 * the Host upgrades, over a read-only one); a write never does, carries a fresh
 * `commandId` and is sent once more with it after `NotAnswering`. The CLI reads
 * files itself and sends their contents.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { TERMINAL, parseWorkflow, type Caller, type WorkRecord, type WorkState, type z } from '@system/work'
// By path, not by package: declaring @system/host here would change the lockfile.
import { NotAnswering, NotRunning, RpcError, UPGRADING, type Client, type Methods } from '../../host/lib/index.js'
import { operations, type Services } from '../../host/lib/operations.js'
import { caller } from './io.ts'

/** The operation table of the code this client runs with: the one source of method names and params. */
type Table = ReturnType<typeof operations>
export type Method = keyof Table & string
/** What a caller gives for `method`: the row's params, without the `commandId` the client adds. */
export type Params<M extends Method> = Omit<z.input<NonNullable<Table[M]['params']>>, 'commandId'>
/** What the row's handler answers. */
export type Result<M extends Method> = Awaited<ReturnType<Table[M]['handler']>>

/** What a command that follows a Work accepts: Ctrl-C detaches, or with this cancels the Work and goes on following it. */
interface FollowOptions {
  cancelOnInterrupt?: boolean
  /** Aborting it ends the following without a word; the result is `stopped`. */
  signal?: AbortSignal
  /** Keep reading across a Host restart or a slow Host, for up to `RECONNECT_MS` of one outage (`work wait`, which only watches). */
  patient?: boolean
  /** Told whether the last call failed (true) or was answered (false); for `waitFor`. */
  outage?: (down: boolean) => void
}

/** What `work wait` accepts: with `any` it returns at the first Work that ended, otherwise when all have; after `timeoutMs` it gives up. */
export interface WaitOptions {
  any: boolean
  timeoutMs?: number
}

/** The Works as they are when the wait returned, and the one whose ending decided it (none on a timeout or Ctrl-C). */
export interface Waited {
  records: WorkRecord[]
  decided?: string
  timedOut: boolean
  /** The Host did not answer for the bound; the Works were not read. */
  unreachable?: string
}

/** A Work's record once it is terminal, or `detached` when the operator left it running in the Host. */
export type Followed = WorkRecord | 'detached' | 'stopped'

interface RemoteLoginView {
  url: string
  port: number
  ssh: string
  expiresAt: number
}

/** The Host as the CLI uses it: one call per table row, and the flows that are more than one call. */
export interface HostClient {
  /** One operation of the table; `timeout` overrides the connection's for this call. */
  call<M extends Method>(method: M, params: Params<M>, options?: { timeout?: number }): Promise<Result<M>>
  /** Start the Work in the Host and follow it until it is terminal. */
  run(workId: string, follow?: FollowOptions): Promise<Followed>
  retry(params: Params<'work.retry'>, follow?: FollowOptions): Promise<Followed>
  /** A decision is a human's: its own connection says so. Then follow the Work. */
  decide(params: Params<'approval.decide'>, operatorId: string): Promise<Followed>
  /** Wait until nothing runs the Work, as after a cancel was requested. */
  wait(workId: string): Promise<Followed>
  /** Wait for every one of `workIds`, or with `any` the first, to end, be held or await approval. */
  waitFor(workIds: string[], options: WaitOptions): Promise<Waited>
  /** The remote sign-in: `show` is given where to reach the viewer once it is up; resolves when it ends. Ctrl-C cancels it. */
  loginRemote(ref: string, show: (view: RemoteLoginView) => void): Promise<{ signedIn: boolean; detail: string }>
}

/** What the call policy needs of a table row. */
export interface Row {
  /** It only reads: a repeat is harmless, and a read-only connection may serve it. */
  read: boolean
  /** Its params declare `commandId`: the Host does it once per id. */
  takesId: boolean
}

/** The rows of a table, by method; for its shapes only (no handler runs). */
export function rowsOf(table: Methods): Map<string, Row> {
  return new Map(Object.entries(table).map(([name, row]) => [name, { read: row.read === true, takesId: 'commandId' in ((row.params as unknown as { shape?: object } | undefined)?.shape ?? {}) }]))
}

/** The rows of the code this client runs with. */
export const rows = rowsOf(operations({} as Services))

/** `params` of a write that takes a `commandId`, with one (the caller's, else a fresh one made now so that a repeat reuses it); reads and other writes unchanged. */
export function withCommandId<P extends object>(row: Row | undefined, params: P, prefix = ''): P {
  if (!row || row.read || !row.takesId) return params
  return typeof (params as { commandId?: unknown }).commandId === 'string' ? params : { ...params, commandId: `${prefix}${randomUUID()}` }
}

/** Whether sending `params` again is harmless: a read, or a write with a `commandId` (the Host answers a repeat from its receipt). */
export const repeatable = (row: Row | undefined, params: object): boolean => row?.read === true || typeof (params as { commandId?: unknown }).commandId === 'string'

/** How often `work.events` is asked while following a Work (PROP-0004 C13). */
const POLL_MS = 1000

/** The bound on one outage of any kind (a restart, an upgrade, a Host too slow to answer) that `work wait` waits through; a Host really gone must not hold a session forever. */
export const RECONNECT_MS = 10 * 60_000

/** The cap of the backoff between the retries of a patient read. */
const BACKOFF_CAP_MS = 10_000

/** How long `workers.loginWait` may take: the viewer's session is 15 minutes, then the check. */
const REMOTE_LOGIN_TIMEOUT = 17 * 60_000


export interface Remote {
  /** A connection that has said `host.hello` as `caller`; with `readOnly`, one a Host upgrading to other code still serves its reads on. */
  open(caller: Caller, options?: { readOnly?: boolean }): Promise<Client>
  /** Replaces `RECONNECT_MS`; for tests. */
  reconnectMs?: number
  /** Replaces `POLL_MS` as the first wait between retries of a patient read; for tests. */
  retryMs?: number
  /** Notes for the operator, such as that a Work was left running. */
  err(text: string): void
}

/** A write: it carries a `commandId` when its row takes one, and after a timeout is sent once more with the same one, so the Host does it once. */
async function mutate(client: Client, method: string, params: object, timeout?: number): Promise<any> {
  const given = withCommandId(rows.get(method), params)
  try {
    return await client.call(method, given, timeout)
  } catch (error) {
    if (!(error instanceof NotAnswering) || !repeatable(rows.get(method), given)) throw error
    return client.call(method, given, timeout)
  }
}

/** The Workflow files `text` uses (Sub-workflows), and the ones they use, read from `dir` once each, by name; one not beside it is left to the Host (`workflows/` at the input's base commit, else the Host's own). A file that does not parse is sent as it is: the Host says why. */
export function usedFiles(text: string, dir: string, found: Record<string, string> = {}): Record<string, string> {
  let names: string[]
  try {
    names = parseWorkflow(text).steps.flatMap((s) => ('uses' in s ? [s.uses] : []))
  } catch {
    return found
  }
  for (const name of names) {
    if (Object.hasOwn(found, name)) continue
    let content: string
    try {
      content = readFileSync(join(dir, name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    found[name] = content
    usedFiles(content, dir, found)
  }
  return found
}

/** The Workflow file at `path` (`~` expanded) as the CLI sends it: its contents and the Sub-workflow files beside it. */
export function readWorkflowFile(path: string): { workflow: string; uses: Record<string, string> } {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  const workflow = readFileSync(expanded, 'utf8')
  return { workflow, uses: usedFiles(workflow, dirname(expanded)) }
}

export function hostClient(remote: Remote): HostClient {
  let session: Promise<Client> | undefined
  const link = (): Promise<Client> => (session ??= remote.open(caller()))
  let reading: Promise<Client> | undefined
  /** A read goes over the session; while the Host waits on attempts to upgrade to other code, over a read-only one. */
  const read = async (method: string, params?: object, timeout?: number): Promise<any> => {
    let client: Client
    try {
      client = await link()
    } catch (error) {
      if (!(error instanceof RpcError && error.code === UPGRADING)) throw error
      session = undefined
      client = await (reading ??= remote.open(caller(), { readOnly: true }))
    }
    return client.call(method, params, timeout)
  }
  /**
   * A read that outlives a Host's swap for new code: a connection it closed is opened again (`open` waits for the next Host), once.
   * With `patient` (`work wait`, which only watches) it outlives a Host's restart and a Host too slow to answer too: while the Host
   * is not running, upgrading or not answering, connections are dropped and the same request is sent again after a backoff
   * (from `retryMs ?? POLL_MS`, doubling up to 10 s), for up to `RECONNECT_MS` of one outage. The followers that act
   * (`run`, `retry`, `decide`) still fail at once when the Host is killed.
   * `outage` is told when a call fails and when one answers, so the caller knows whether the Host is unreachable now.
   */
  const reread = async (method: string, params?: object, patient = false, signal?: AbortSignal, outage?: (down: boolean) => void): Promise<any> => {
    let since: number | undefined
    let delay = remote.retryMs ?? POLL_MS
    for (let tries = 0; ; tries++) {
      try {
        const answer = await read(method, params)
        outage?.(false)
        return answer
      } catch (error) {
        const transient = error instanceof NotRunning || (patient && (error instanceof NotAnswering || (error instanceof RpcError && error.code === UPGRADING)))
        if (!transient) throw error
        outage?.(true)
        since ??= Date.now()
        if (patient ? Date.now() - since > (remote.reconnectMs ?? RECONNECT_MS) || signal?.aborted : tries >= 1) throw error
        session = undefined
        reading = undefined
        if (patient) {
          await new Promise<void>((done) => {
            const timer = setTimeout(done, delay)
            signal?.addEventListener('abort', () => { clearTimeout(timer); done() }, { once: true })
          })
          if (signal?.aborted) throw error
          delay = Math.min(delay * 2, Math.max(BACKOFF_CAP_MS, remote.retryMs ?? 0))
        }
      }
    }
  }
  /** A call of the table: a read goes over the session or the read-only one, a write over the session only. */
  const call = async (method: string, params?: object, options?: { timeout?: number }): Promise<any> =>
    rows.get(method)?.read ? read(method, params, options?.timeout) : mutate(await link(), method, params ?? {}, options?.timeout)

  /** Poll `work.events` until the Work is terminal. Ctrl-C detaches, or cancels first with `cancelOnInterrupt`. */
  async function follow(workId: string, options: FollowOptions = {}): Promise<Followed> {
    let after = -1
    let cancelling: Promise<unknown> | undefined
    let interrupt!: () => void
    const interrupted = new Promise<'interrupted'>((resolve) => { interrupt = () => resolve('interrupted') })
    // `signal` ends the following quietly: the caller has what it came for.
    const stopped = new Promise<'stopped'>((resolve) => {
      if (options.signal?.aborted) resolve('stopped')
      else options.signal?.addEventListener('abort', () => resolve('stopped'), { once: true })
    })
    const onInterrupt = () => {
      if (options.cancelOnInterrupt && !cancelling) {
        cancelling = call('work.cancel', { workId, reason: 'cancelled by the operator: interrupted' })
        // A failure is raised when the Work has ended, below.
        cancelling.catch(() => {})
        return
      }
      interrupt()
    }
    process.on('SIGINT', onInterrupt)
    const detach = (): Followed => {
      remote.err(`detached; ${workId} goes on in the Host\n`)
      return 'detached'
    }
    try {
      for (;;) {
        const polled = await Promise.race([reread('work.events', { workId, after }, options.patient, options.signal, options.outage) as Promise<{ events: { seq: number }[]; status: WorkState['status'] }>, interrupted, stopped])
        if (polled === 'stopped') return 'stopped'
        if (polled === 'interrupted') return detach()
        after = polled.events.at(-1)?.seq ?? after
        if (TERMINAL.has(polled.status)) {
          await cancelling
          return await reread('work.show', { workId }, options.patient, options.signal, options.outage)
        }
        const slept = await Promise.race([new Promise<'slept'>((done) => setTimeout(() => done('slept'), POLL_MS)), interrupted, stopped])
        if (slept === 'stopped') return 'stopped'
        if (slept === 'interrupted') return detach()
      }
    } finally {
      process.off('SIGINT', onInterrupt)
    }
  }

  return {
    call: call as HostClient['call'],
    async run(workId, options) {
      await call('work.run', { workId })
      return follow(workId, options)
    },
    async retry(params, options) {
      await call('work.retry', params)
      return follow(params.workId, options)
    },
    async decide(params, operator) {
      // A decision is a human's: its own connection says so, whoever the other calls are.
      const human = await remote.open({ type: 'human', operatorId: operator })
      try {
        await mutate(human, 'approval.decide', params)
      } finally {
        human.close()
      }
      return follow(params.workId)
    },
    wait: (workId) => follow(workId),
    async waitFor(workIds, { any, timeoutMs }: WaitOptions): Promise<Waited> {
      const stop = new AbortController()
      let timedOut = false
      let down = false
      let decided: string | undefined
      const outage = (now: boolean) => { down = now }
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; stop.abort() }, timeoutMs)
      // Each Work is followed as `work run` follows one; a Work that ended (held and awaiting approval included) decides.
      const ended = workIds.map(async (workId) => {
        const followed = await follow(workId, { signal: stop.signal, patient: true, outage })
        if (typeof followed === 'object' && !(any && decided)) decided = workId
      })
      const unreachable = (error: unknown): string => {
        if (error instanceof NotAnswering || error instanceof NotRunning || (error instanceof RpcError && error.code === UPGRADING)) return error.message
        throw error
      }
      let gone: string | undefined
      try {
        await (any ? Promise.race(ended) : Promise.all(ended))
      } catch (error) {
        gone = unreachable(error)
      } finally {
        clearTimeout(timer)
        stop.abort()
        for (const one of ended) one.catch(() => {})
      }
      // The timeout fired while a call was failing: the Host was unreachable, not merely slow to finish.
      if (gone === undefined && timedOut && down) gone = 'the Host did not answer before the timeout'
      if (gone !== undefined) return { records: [], timedOut: false, unreachable: gone }
      // The records as they are now, whichever ended: a read, so it works while the Host upgrades.
      try {
        const records = await Promise.all(workIds.map((workId) => reread('work.show', { workId }, true, undefined, outage) as Promise<WorkRecord>))
        return { records, decided: timedOut ? undefined : decided, timedOut }
      } catch (error) {
        return { records: [], timedOut: false, unreachable: unreachable(error) }
      }
    },
    // A manual sign-in waits for the operator, so this call outlasts the usual answer time.
    loginRemote: async (ref, show) => {
      show(await call('workers.loginRemote', { ref }))
      const client = await link()
      // Ctrl-C ends the session in the Host; the wait below then returns its report.
      const onInterrupt = () => { void client.call('workers.loginWait', { ref, cancel: true }).catch(() => {}) }
      process.once('SIGINT', onInterrupt)
      try {
        return await client.call('workers.loginWait', { ref }, REMOTE_LOGIN_TIMEOUT) as any
      } finally {
        process.off('SIGINT', onInterrupt)
      }
    },
  }
}
