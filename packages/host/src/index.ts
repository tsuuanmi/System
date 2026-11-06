/**
 * The Host's transport (PROP-0004 C5, C17): JSON-RPC 2.0 over a Unix socket,
 * one JSON object per line as MCP's stdio transport frames it. The methods
 * are a table, `method -> { handler, agent }`; the Work operations are rows
 * added to it.
 */
import { readFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { Caller, Host, z } from '@system/work'

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/** The largest line, in bytes, either side accepts. */
export const MAX_FRAME = 1024 * 1024
/** How long a call waits for its answer, in milliseconds. */
export const CALL_TIMEOUT = 10_000

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
/** Refused by the Host: a handshake not done or not matching. */
export const REFUSED = -32000
/** An operation closed to agents, called by one. */
export const NOT_ALLOWED = -32001

export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export interface Method {
  /** One line for the API reference: what it does and returns. */
  summary?: string
  /** The shape of `params`; a call that does not fit is refused with -32602, and the handler gets the parsed value. */
  params?: z.ZodType
  handler: (host: Host, params: any, caller: Caller) => unknown | Promise<unknown>
  /** Whether a caller of type `agent` may call it. */
  agent: boolean
}
export type Methods = Record<string, Method>

export interface ServeOptions {
  path: string
  /** Extra rows over the built-in `host.*` ones. */
  methods?: Methods
  /** The version a hello must carry; the CLI package version. */
  version?: string
}

export interface Served {
  close(): Promise<void>
}

/** The memory report (C18): what the records weigh, counted from the records. */
const report = (host: Host) => {
  const records = host.list()
  return { version: VERSION, pid: process.pid, works: records.length, recordBytes: records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0) }
}

/** The `host.*` rows every Host serves, besides `host.hello`, which the connection itself handles. */
const builtin: Methods = {
  'host.ping': { agent: true, summary: 'Whether the Host answers: `{ version, pid, works, recordBytes }`.', handler: (host) => report(host) },
  'host.status': { agent: true, summary: 'The memory report (C18), counted from the records: the same `{ version, pid, works, recordBytes }`, for the growth budget.', handler: (host) => report(host) },
}

/** The whole table a Host serves: the built-in rows and `extra`. */
export const tableOf = (extra: Methods = {}): Methods => ({ ...builtin, ...extra })

const callerOf = (value: any): Caller | undefined =>
  value && (value.type === 'human' || value.type === 'agent') && typeof value.operatorId === 'string' && value.operatorId ? { type: value.type, operatorId: value.operatorId } : undefined

/** Listen on `options.path`; each connection must say `host.hello` before any other method. */
export async function serve(host: Host, options: ServeOptions): Promise<Served> {
  const methods = tableOf(options.methods)
  const version = options.version ?? VERSION
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    let caller: Caller | undefined
    const send = (message: object) => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`) }
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
          if (!next) throw new RpcError(INVALID_PARAMS, 'host.hello needs caller: { type: "human" | "agent", operatorId }')
          if (request.params.version !== version) {
            throw new RpcError(REFUSED, `the Host runs version ${version} and the client ${String(request.params.version)}; restart the Host: systemctl --user restart system`)
          }
          caller = next
          return send({ jsonrpc: '2.0', id, result: { version } })
        }
        const method = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined
        if (!method) throw new RpcError(METHOD_NOT_FOUND, `unknown method ${request.method}`)
        if (!caller) throw new RpcError(REFUSED, `say host.hello first: ${request.method} needs a version and a caller`)
        if (caller.type === 'agent' && !method.agent) throw new RpcError(NOT_ALLOWED, `${request.method}: not allowed for agents`)
        let params = request.params
        if (method.params) {
          const parsed = method.params.safeParse(params ?? {})
          if (!parsed.success) throw new RpcError(INVALID_PARAMS, `invalid params for ${request.method}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`)
          params = parsed.data
        }
        send({ jsonrpc: '2.0', id, result: await method.handler(host, params, caller) ?? null })
      } catch (error) {
        if (error instanceof RpcError) fail(id, error.code, error.message)
        else fail(id, -32603, error instanceof Error ? error.message : String(error))
      }
    }

    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (let at = buffer.indexOf(10); at >= 0 && at <= MAX_FRAME; at = buffer.indexOf(10)) {
        const line = buffer.subarray(0, at)
        buffer = buffer.subarray(at + 1)
        if (line.length) void handle(line.toString('utf8'))
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
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      for (const socket of sockets) socket.destroy()
    }),
  }
}

export interface Client {
  call(method: string, params?: unknown): Promise<unknown>
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
    let next = 1
    let gone: Error | undefined
    const drop = (error: Error) => {
      gone ??= error
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(gone) }
      pending.clear()
    }
    socket.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? new Error(`the Host is not running (no answer at ${path}); start it: systemctl --user start system`) : error)
    })
    socket.on('error', (error) => drop(error))
    socket.on('close', () => drop(new Error('the Host closed the connection')))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let reply: any
        try { reply = JSON.parse(line) } catch { continue }
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
      call(method, params) {
        if (gone) return Promise.reject(gone)
        const id = next++
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            rej(new Error(`the Host is not answering ${method} after ${timeout} ms`))
          }, timeout)
          pending.set(id, { resolve: res, reject: rej, timer })
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        })
      },
      close() { socket.destroy() },
    }))
  })
}
