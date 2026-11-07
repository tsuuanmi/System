/**
 * The Host's transport (PROP-0004 C5, C17): JSON-RPC 2.0 over a Unix socket,
 * one JSON object per line as MCP's stdio transport frames it. The methods
 * are a table, `method -> { handler, agent }`; the Work operations are rows
 * added to it.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Caller, Host, WorkChange, z } from '@system/work'

/** The package version, shown by `host.hello`; it does not tell two builds apart. */
export const PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const SYSTEM_PACKAGES = ['artifacts', 'work', 'agents', 'verifiers', 'effects', 'host', 'app']

const jsFiles = (dir: string, at = ''): string[] =>
  readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsFiles(dir, join(at, e.name)) : e.name.endsWith('.js') ? [join(at, e.name)] : []))

/**
 * What identifies the code: a short sha256 over the built `.js` files of the
 * System packages, in a stable order. A directory that is not built counts as
 * empty. The Host and each client compute it from their own files, so a
 * Host still running old code refuses a client built from new code.
 */
export function codeVersion(libs: Record<string, string> = Object.fromEntries(SYSTEM_PACKAGES.map((name) => [name, new URL(`../../${name}/lib`, import.meta.url).pathname]))): string {
  const hash = createHash('sha256')
  for (const name of Object.keys(libs).sort()) {
    let files: string[] = []
    try { files = jsFiles(libs[name]!).sort() } catch { /* not built */ }
    for (const file of files) hash.update(`${name}/${file}\0`).update(readFileSync(join(libs[name]!, file))).update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

export const VERSION: string = codeVersion()

/** The largest line, in bytes, either side accepts. */
export const MAX_FRAME = 1024 * 1024
/** Whether base64 text leaves room in a frame for the rest of its message. */
export const fitsFrame = (base64: string): boolean => base64.length <= MAX_FRAME - 1024
/** How long a call waits for its answer, in milliseconds. */
export const CALL_TIMEOUT = 10_000

/** The line is not JSON; the connection stays open. */
export const PARSE_ERROR = -32700
/** Not a JSON-RPC 2.0 request, or a line over `MAX_FRAME` (the connection is closed). */
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
/** A malformed hello, or params that do not fit the row's schema. */
export const INVALID_PARAMS = -32602
/** The handler failed. */
export const INTERNAL_ERROR = -32603
/** Refused by the Host: no hello yet, or a version mismatch. */
export const REFUSED = -32000
/** An operation flagged `agent: false`, called by an agent or an orchestrator; or a call outside an orchestrator's Goal. */
export const NOT_ALLOWED = -32001

export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/** Nothing listens at the socket: the Host is not running. */
export class NotRunning extends Error {}

/** A call got no answer in time. A client may repeat a call that carries a `commandId`. */
export class NotAnswering extends Error {}

/** What a connection watches, for the rows that keep it subscribed (`work.watch`). The connection sends the notices; a closed one drops them. */
export interface Link {
  works: Set<string>
  goals: Set<string>
  /** Start hearing the Host's changes, once: call it after adding to `works` or `goals`. */
  listen(): void
}

export interface Method {
  /** One line for the API reference: what it does and returns. */
  summary?: string
  /** The shape of `params`; a call that does not fit is refused with -32602, and the handler gets the parsed value. */
  params?: z.ZodType
  handler: (host: Host, params: any, caller: Caller, link: Link) => unknown | Promise<unknown>
  /**
   * For an `orchestrator` caller only, before the handler: throw `NOT_ALLOWED` naming the scope when the call
   * reaches outside its Goal, or return the params to run with (ADR-0009 decision 4). A row without one is not scoped.
   */
  scope?: (host: Host, params: any, caller: Caller & { type: 'orchestrator' }) => unknown
  /** Whether a caller of type `agent` may call it. */
  agent: boolean
}
export type Methods = Record<string, Method>

export interface ServeOptions {
  path: string
  /** Extra rows over the built-in `host.*` ones. */
  methods?: Methods
  /** The code version a hello must carry; default: this build's `VERSION`. */
  version?: string
  /** Milliseconds `close` lets admitted calls finish before it drops the connections; default `STOP_GRACE`. */
  grace?: number
}

/** How long a stopping Host lets admitted calls finish, in milliseconds. */
export const STOP_GRACE = 2_000

export interface Served {
  /** Stop accepting, let admitted calls finish for the grace, drop every connection, and close. Never waits on a client. */
  close(): Promise<void>
}

/** The `host.*` rows every Host serves, besides `host.hello`, which the connection itself handles. */
const builtin: Methods = {
  'host.status': {
    agent: true,
    summary: 'Whether the Host answers, and the memory report (C18) counted from the records, for the growth budget: `{ version, pid, works, recordBytes }`.',
    handler(host) {
      const records = host.list()
      return { version: VERSION, pid: process.pid, works: records.length, recordBytes: records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0) }
    },
  },
}

/** The whole table a Host serves: the built-in rows and `extra`. */
export const tableOf = (extra: Methods = {}): Methods => ({ ...builtin, ...extra })

const GOAL_ID = /^sha256:[0-9a-f]{64}$/

const callerOf = (value: any): Caller | undefined => {
  if (!value || typeof value.operatorId !== 'string' || !value.operatorId) return undefined
  if (value.type === 'human' || value.type === 'agent') return { type: value.type, operatorId: value.operatorId }
  return value.type === 'orchestrator' && typeof value.goal === 'string' && GOAL_ID.test(value.goal) ? { type: 'orchestrator', operatorId: value.operatorId, goal: value.goal } : undefined
}

/** Listen on `options.path`; each connection must say `host.hello` before any other method. */
export async function serve(host: Host, options: ServeOptions): Promise<Served> {
  const methods = tableOf(options.methods)
  const version = options.version ?? VERSION
  const sockets = new Set<Socket>()
  const inflight = new Set<Promise<void>>()
  let stopping = false
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    let caller: Caller | undefined
    const send = (message: object) => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`) }
    // A notice has no id and is no answer: it only wakes the client, which reads `work.events` from its cursor.
    const notify = ({ workId, status, seq, type }: WorkChange) => {
      const goal = type === 'admitted' ? host.get(workId)?.events[0] : undefined
      const admitted = goal?.type === 'admitted' && goal.goal !== undefined && [...link.goals].some((watched) => host.goalChain(watched).has(goal.goal!))
      if ((type === 'terminal' && link.works.has(workId)) || admitted) send({ jsonrpc: '2.0', method: 'work.changed', params: { workId, status, seq } })
    }
    let stopListening: (() => void) | undefined
    const link: Link = { works: new Set(), goals: new Set(), listen() { stopListening ??= host.onChange(notify) } }
    socket.on('close', () => stopListening?.())
    const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } })

    async function handle(line: string): Promise<void> {
      let request: any
      try { request = JSON.parse(line) } catch { return fail(null, PARSE_ERROR, 'parse error: not JSON') }
      const id = request?.id
      if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !(typeof id === 'number' || typeof id === 'string')) {
        return fail(typeof id === 'number' || typeof id === 'string' ? id : null, INVALID_REQUEST, 'invalid request: expected a JSON-RPC 2.0 request with a method and an id')
      }
      try {
        if (request.method === 'host.hello') {
          const next = callerOf(request.params?.caller)
          if (!next) throw new RpcError(INVALID_PARAMS, 'host.hello needs caller: { type: "human" | "agent", operatorId } or { type: "orchestrator", operatorId, goal }')
          if (request.params.version !== version) {
            throw new RpcError(REFUSED, `the Host runs code ${version} and the client ${String(request.params.version)}; restart the Host: systemctl --user restart system (or restart \`system host\`)`)
          }
          caller = next
          return send({ jsonrpc: '2.0', id, result: { version, packageVersion: PACKAGE_VERSION } })
        }
        const method = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined
        if (!method) throw new RpcError(METHOD_NOT_FOUND, `unknown method ${request.method}`)
        if (!caller) throw new RpcError(REFUSED, `say host.hello first: ${request.method} needs a version and a caller`)
        if (caller.type !== 'human' && !method.agent) throw new RpcError(NOT_ALLOWED, `${request.method}: not allowed for ${caller.type === 'agent' ? 'agents' : 'orchestrators'}`)
        let params = request.params
        if (method.params) {
          const parsed = method.params.safeParse(params ?? {})
          if (!parsed.success) throw new RpcError(INVALID_PARAMS, `invalid params for ${request.method}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`)
          params = parsed.data
        }
        if (caller.type === 'orchestrator' && method.scope) params = method.scope(host, params, caller)
        send({ jsonrpc: '2.0', id, result: await method.handler(host, params, caller, link) ?? null })
      } catch (error) {
        if (error instanceof RpcError) fail(id, error.code, error.message)
        else fail(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
      }
    }

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (let at = buffer.indexOf(10); at >= 0 && at <= MAX_FRAME; at = buffer.indexOf(10)) {
        const line = buffer.subarray(0, at)
        buffer = buffer.subarray(at + 1)
        if (!line.length || stopping) continue
        const call = handle(line.toString('utf8')).finally(() => inflight.delete(call))
        inflight.add(call)
      }
      if (buffer.length > MAX_FRAME) {
        fail(null, INVALID_REQUEST, `invalid request: a line is larger than ${MAX_FRAME} bytes`)
        buffer = Buffer.alloc(0)
        socket.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.path, () => { server.off('error', reject); resolve() })
  })
  return {
    async close() {
      stopping = true
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      let timer: NodeJS.Timeout | undefined
      await Promise.race([Promise.allSettled(inflight), new Promise((resolve) => { timer = setTimeout(resolve, options.grace ?? STOP_GRACE) })])
      clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await closed
    },
  }
}

export interface Client {
  /** `timeout` overrides the connection's for this call. */
  call(method: string, params?: unknown, timeout?: number): Promise<unknown>
  /** Hear the Host's notifications (JSON-RPC messages without an `id`, such as `work.changed`). */
  onNotice(listener: (method: string, params: unknown) => void): void
  close(): void
}

export interface ConnectOptions {
  /** Milliseconds a call waits for its answer. */
  timeout?: number
}

/** Connect to a Host's socket. A refusal says the Host is not running. */
export function connect(path: string, options: ConnectOptions = {}): Promise<Client> {
  const timeout = options.timeout ?? CALL_TIMEOUT
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(path)
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
    const listeners: ((method: string, params: unknown) => void)[] = []
    let next = 1
    let gone: Error | undefined
    const drop = (error: Error) => {
      gone ??= error
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(gone) }
      pending.clear()
    }
    socket.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? new NotRunning(`the Host is not running (no answer at ${path}); start it: systemctl --user start system`) : error)
    })
    const closed = () => new NotRunning('the Host closed the connection (it stopped or was restarted): the Host is not running; start it: systemctl --user start system')
    socket.on('error', (error: NodeJS.ErrnoException) => drop(error.code === 'ECONNRESET' || error.code === 'EPIPE' ? closed() : error))
    socket.on('close', () => drop(closed()))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let reply: any
        try { reply = JSON.parse(line) } catch { continue }
        if (reply && typeof reply.method === 'string' && reply.id === undefined) {
          for (const listener of listeners) listener(reply.method, reply.params)
          continue
        }
        const call = pending.get(reply?.id)
        if (!call) {
          // An error without an id (an oversize frame) is for whoever waits.
          if (reply?.error) drop(new RpcError(reply.error.code, reply.error.message))
          continue
        }
        pending.delete(reply.id)
        clearTimeout(call.timer)
        if (reply.error) call.reject(new RpcError(reply.error.code, reply.error.message))
        else call.resolve(reply.result)
      }
    })
    socket.once('connect', () => resolve({
      call(method, params, callTimeout = timeout) {
        if (gone) return Promise.reject(gone)
        const id = next++
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            rej(new NotAnswering(`the Host is not answering ${method} after ${callTimeout} ms`))
          }, callTimeout)
          pending.set(id, { resolve: res, reject: rej, timer })
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        })
      },
      onNotice(listener) { listeners.push(listener) },
      close() { socket.destroy() },
    }))
  })
}
