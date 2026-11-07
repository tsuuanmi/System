/**
 * `system mcp [--goal <id>]` (ADR-0009 decision 3): a stdio MCP server that
 * is a client of the Host. Its tools are the rows of the Host's operation
 * table flagged `agent: true`, with the row's zod params as JSON Schema and
 * its summary as the description; each call is forwarded over the socket. It
 * decides nothing: who may do what is the Host's, from the caller it declares.
 * Each Work in scope is also a resource, `system://work/<id>`, whose reading
 * is `work.show`; a subscription is a `work.watch` on the connection, and the
 * Host's `work.changed` becomes `notifications/resources/updated` (ADR-0009
 * decision 5). A notice only wakes the client, which reads `work.events` from
 * its cursor.
 */
import { parseArgs } from 'node:util'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CONTENT_ID_RE } from '@system/artifacts'
import { z, type Caller } from '@system/work'
// By path, not by package: declaring @system/host here would change the lockfile.
import { RpcError, tableOf, type Client } from '../../host/lib/index.js'
import { operations, type Services } from '../../host/lib/operations.js'
import { explain, operatorId } from './io.ts'

/** The Host's table, for its shapes only: no handler of it runs here. */
const table = tableOf(operations({} as Services))

/** The MCP tools: one per row flagged `agent: true`. */
export const tools = Object.entries(table).filter(([, row]) => row.agent).map(([name, row]) => ({
  name,
  description: row.summary,
  inputSchema: z.toJSONSchema(row.params ?? z.object({}).strict(), { io: 'input' }) as { type: 'object'; [key: string]: unknown },
}))

const WORK_URI = /^system:\/\/work\/(.+)$/

/** The Work a resource URI names. */
const workOf = (uri: string): string => {
  const id = WORK_URI.exec(uri)?.[1]
  if (!id) throw new Error(`unknown resource ${uri}: a resource is system://work/<id>`)
  return id
}

/** Serve MCP on stdio until the client closes it; resolves the exit code. */
export async function runMcp(args: string[], home: string, open: (who: Caller) => Promise<Client>): Promise<number> {
  let goal: string | undefined
  try {
    goal = parseArgs({ args, options: { goal: { type: 'string' } }, allowPositionals: false }).values.goal
    if (goal !== undefined && !CONTENT_ID_RE.test(goal)) throw new Error(`--goal needs a Goal ID (sha256:...), not ${goal}`)
  } catch (error) {
    process.stderr.write(`system: mcp: ${(error as Error).message}\nusage: system mcp [--goal <goal-id>]\n`)
    return 2
  }
  const who: Caller = goal ? { type: 'orchestrator', operatorId: operatorId(), goal } : { type: 'agent', operatorId: operatorId() }

  const server = new Server({ name: 'system', version: '0.0.0' }, { capabilities: { tools: {}, resources: { subscribe: true, listChanged: goal !== undefined } } })
  /** The Works the client subscribed to; each connection to the Host watches them again when it is opened. */
  const subscribed = new Set<string>()
  const heard = (method: string, params: unknown) => {
    if (method !== 'work.changed') return
    const { workId, seq } = params as { workId: string; seq: number }
    // A first event is a new Work of the Goal; any other is a change of a subscribed Work.
    if (seq === 0) void server.sendResourceListChanged().catch(() => {})
    else if (subscribed.has(workId)) void server.sendResourceUpdated({ uri: `system://work/${workId}` }).catch(() => {})
  }
  const connectHost = async (): Promise<Client> => {
    const client = await open(who)
    client.onNotice(heard)
    const watches = [...subscribed].map((workId) => ({ workId }))
    await Promise.allSettled([...(goal ? [{ goal }] : []), ...watches].map((params) => client.call('work.watch', params)))
    return client
  }
  let session: Promise<Client> | undefined
  const link = () => (session ??= connectHost().catch((error) => { session = undefined; throw error }))
  /** A failure as the message the client reads; a lost connection is opened again by the next call. */
  const failed = (error: unknown): Error => {
    if (!(error instanceof RpcError)) session = undefined
    const failure = explain(error, home)
    return failure instanceof Error ? failure : new Error(String(failure))
  }
  server.oninitialized = () => { if (goal) link().catch(() => {}) }
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      if (!tools.some((tool) => tool.name === params.name)) throw new Error(`unknown tool ${params.name}`)
      const result = await (await link()).call(params.name, params.arguments ?? {})
      return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: failed(error).message }] }
    }
  })
  /** Run a Host call for a resource request: a failure is the request's error. */
  const forwarded = async (method: string, params: object): Promise<unknown> => {
    try {
      return await (await link()).call(method, params)
    } catch (error) {
      throw failed(error)
    }
  }
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: ((await forwarded('work.list', {})) as { id: string; status: string }[]).map((work) => ({ uri: `system://work/${work.id}`, name: work.id, description: `Work ${work.id}: ${work.status}`, mimeType: 'application/json' })),
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
    contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(await forwarded('work.show', { workId: workOf(params.uri) })) }],
  }))
  server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    const workId = workOf(params.uri)
    await forwarded('work.watch', { workId })
    subscribed.add(workId)
    return {}
  })
  server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
    const workId = workOf(params.uri)
    subscribed.delete(workId)
    await forwarded('work.unwatch', { workId })
    return {}
  })
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve
    // A client ends the session by closing our stdin.
    process.stdin.once('end', resolve)
  })
  await server.connect(new StdioServerTransport())
  await closed
  if (session) (await session.catch(() => undefined))?.close()
  return 0
}
