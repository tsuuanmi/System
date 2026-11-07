/**
 * `system mcp [--goal <id>]` (ADR-0009 decision 3): a stdio MCP server that
 * is a client of the Host. Its tools are the rows of the Host's operation
 * table flagged `agent: true`, with the row's zod params as JSON Schema and
 * its summary as the description; each call is forwarded over the socket. It
 * decides nothing: who may do what is the Host's, from the caller it declares.
 */
import { parseArgs } from 'node:util'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
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

  let session: Promise<Client> | undefined
  const link = () => (session ??= open(who).catch((error) => { session = undefined; throw error }))

  const server = new Server({ name: 'system', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      if (!tools.some((tool) => tool.name === params.name)) throw new Error(`unknown tool ${params.name}`)
      const result = await (await link()).call(params.name, params.arguments ?? {})
      return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] }
    } catch (error) {
      // A lost connection is opened again by the next call; an answer of the Host keeps it.
      if (!(error instanceof RpcError)) session = undefined
      const failure = explain(error, home)
      return { isError: true, content: [{ type: 'text' as const, text: failure instanceof Error ? failure.message : String(failure) }] }
    }
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
