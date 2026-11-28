/**
 * `system mcp`: a stdio MCP server that
 * is a client of the Host. Its tools are the rows with `authority: 'caller'` of the
 * operation table of the code the Host runs (rebuilt when the process recovers
 * on newer code, with `notifications/tools/list_changed`), with the row's zod params as JSON Schema and
 * its summary as the description; each call is forwarded over the socket. A call
 * that finds the connection closed (the Host restarted) reconnects once and is
 * sent again only if its repeat is idempotent: a read, or a write with a `commandId` (made here when the caller gave none). It
 * decides nothing: who may do what is the Host's, from the caller it declares.
 * Each Work is also a resource, `system://work/<id>`, whose reading
 * is `work.show`; a subscription is a `work.watch` on the connection, and the
 * Host's `work.changed` (see the Host README) becomes
 * `notifications/resources/updated`.
 */
import { parseArgs } from 'node:util'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Caller } from '@system/work'
import { NotRunning, RpcError, annotationsOf, paramsSchemaOf, tableOf, type Client, type Methods } from '@system/host'
import { operations, type Services } from '@system/host/operations'
import { explain, operatorId } from './io.ts'
import { readWorkflowFile, repeatable, rowsOf, withCommandId, type Row } from './remote.ts'

/** What a code root offers `system mcp`: its operation table builder. */
export interface Code { operations: (services: Services) => Methods; tableOf: typeof tableOf }

/** The MCP tools of a code's table, for its shapes only (no handler runs here): one per row with `authority: 'caller'`. */
export const toolsOf = ({ operations, tableOf }: Code) => Object.entries(tableOf(operations({} as Services))).filter(([, row]) => row.authority === 'caller').map(([name, row]) => ({
  name,
  description: row.summary,
  inputSchema: paramsSchemaOf(row),
  annotations: annotationsOf(row),
}))

export const tools = toolsOf({ operations, tableOf })

/** The call policy's rows of a code's table (which operations only read, which take a `commandId`), for its shapes only. */
const rowsOfCode = ({ operations, tableOf }: Code): Map<string, Row> => rowsOf(tableOf(operations({} as Services)))

/**
 * What a session is told when it connects (the MCP `instructions`), so that
 * it can use System from any repository without reading System's docs.
 */
/** `work.submit`'s `workflow` as a path: one line ending in .yaml or .yml. The MCP server runs on the Host's machine, so it reads the file as the CLI does; anything else is contents. */
function withWorkflowFile(method: string, args: Record<string, unknown>): Record<string, unknown> {
  const path = typeof args.workflow === 'string' ? args.workflow.trim() : ''
  if (method !== 'work.submit' || !path || /[\r\n]/.test(path) || !/\.ya?ml$/i.test(path)) return args
  try {
    const { workflow, uses } = readWorkflowFile(path)
    const sent = args.uses && typeof args.uses === 'object' ? args.uses : {}
    return { ...args, workflow, uses: { ...uses, ...sent } }
  } catch (error) {
    throw new Error(`workflow ${path}: not a readable file (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); give the path of a Workflow .yaml file on this machine, or the Workflow's contents`)
  }
}

export const INSTRUCTIONS = `System is the durable work control plane on this machine. This session is a
caller: a Worker (a separate agent, in a clean worktree of the repository)
makes the change, and results come back as Artifact IDs.

When to use it
- A change that must be checked and merged, independent attempts, or work that
  should survive this session.
- Quick edits and questions stay in this session.

What a repository needs
- It is on GitHub, has a \`dev\` branch, and a committed \`.system/checks.yaml\`.
- System merges a change into \`dev\` when its checks pass. The operator
  merges \`dev\` into \`main\`.

Steps (the tools may be shown as status, item_claim, task_new, work_submit, with _ for .)
1. \`status\` with the repository: what is done, in progress (by whom) and to do.
   To carry an Item on before a Work exists, \`item_claim\` it; status then
   shows your claim, and the Work you submit for the Item takes it over.
2. \`task_new\` with the repository, the ref and the \`item\`; its result is
   \`{ task, base }\`: pass \`task\` alone as the input.
   For a change, write the Task's instructions as a context pack, prose under
   these headings, so the Worker reads the named files first instead of
   exploring: Goal (what and why); Files to change and why (the files the
   Worker reads first); Tests to add or update; Invariants not to change;
   Out of scope; Done when (what shows it is finished).
   One Item fits one Worker attempt (about an hour): split a Done when with
   several independent parts into several Items. Template:
   ~/.system/current/workflows/README.md.
3. \`work_submit\` with the Workflow file
   ~/.system/current/workflows/develop.yaml for any change to a repository
   (the Worker writes the tests first, then the code, and runs the checks);
   \`workflow\` is that file's path on this machine (\`~\` expanded), or the
   Workflow's contents. The others there: hygiene.yaml (a cleanup that keeps
   behaviour), research.yaml (questions answered from the web),
   research-source.yaml (questions about a repository's source),
   plan-items.yaml (Item lines proposed from an Intent), brainstorm.yaml, and code-checks.yaml (the Sub-workflow the others use to
   check a change).
4. Follow it with \`work_watch\` or \`work_events\`; read details by ID
   (\`work_show\`, \`artifact_show\`). To know when a Work is done without
   asking, run \`system work wait <id>\` as a background command.

Intent
When the operator settles what they want ("chốt", "đồng ý", "yes"), store it
with \`intent_new\` (title; Markdown body with Outcome, Why, Constraints and
Out of scope) before you write Items. Encouraged for new Items, not required.
Set \`settledByOperator: true\` only when the operator settled that Intent in
this session; System does not see the conversation, so an Intent without it is
not counted as an operator act. Likewise call \`artifact_confirm\` (the stored
Artifact's ID and a note) only when the operator confirmed that dataset or
label set in this session.

Bootstrap of a new repository (you do this, there is no script)
1. Run \`system bootstrap plan --repo <path>\` and do the human steps it prints.
2. Ask the operator before creating \`dev\` from \`main\`.
3. The first \`.system/checks.yaml\` is a direct commit on \`dev\` that the operator reviews: admission
   refuses a Work without one.
4. Write STATUS.md (Aim and Items) and commit it on \`dev\` before the push.
5. Run \`system bootstrap check\` until it passes. If AGENTS.md is missing, write it from
   section 9, "Repository profile and agent
   contract", of ~/.system/current/docs/governance/documentation-architecture.md.

Only a human approves, denies or verifies again. Never try to act as the
human: print the exact command for the operator to run in a terminal, such as
\`system approve <work>\`, \`system deny <work>\` or
\`system work retry <work> --step checks.checks\`.
`

/** The most an MCP tool result shows, in bytes (alog-2): reads are bounded where they are shown; the Host and the CLI keep everything. */
export const RESULT_BOUND = 32 * 1024
/** `artifact.cat`'s part through MCP when the caller gave no `maxBytes`: its base64 and the reply's other fields fit the bound. */
const CAT_PART = 24_000

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null')

/** A `work.show` result over the bound without its oldest events, saying how many were left out and which call returns them. */
export function boundShow(record: unknown): unknown {
  const shown = record as { events?: unknown[] } | null
  if (sizeOf(record) <= RESULT_BOUND || !shown || !Array.isArray(shown.events)) return record
  const events = shown.events
  const trimmed = (dropped: number) => ({ ...shown, events: events.slice(dropped), omittedEvents: dropped, omittedNote: `the ${dropped} oldest events are left out; \`work.events\` returns them` })
  let low = 0
  let high = events.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sizeOf(trimmed(middle)) <= RESULT_BOUND) high = middle
    else low = middle + 1
  }
  return trimmed(low)
}

/** The text of a tool result: itself when within the bound, else its first bytes and a marker line with the full size and the call that returns the rest. */
export function boundText(text: string, tool: string): string {
  const size = Buffer.byteLength(text)
  if (size <= RESULT_BOUND) return text
  const kept = Buffer.from(text).subarray(0, RESULT_BOUND).toString('utf8').replace(/\uFFFD+$/, '')
  const rest = tool === 'artifact.cat' ? 'call `artifact.cat` with `offset` and a smaller `maxBytes` to read the rest'
    : tool === 'work.show' ? 'call `work.events` for the events'
      : tool === 'work.events' ? 'call `work.events` again with `after` set to the last `seq` you read'
      : `call \`${tool}\` again with narrower arguments for the rest`
  return `${kept}\n[cut: the result is ${size} bytes, the first ${Buffer.byteLength(kept)} are shown; ${rest}]`
}

const WORK_URI = /^system:\/\/work\/(.+)$/

/** The Work a resource URI names. */
const workOf = (uri: string): string => {
  const id = WORK_URI.exec(uri)?.[1]
  if (!id) throw new Error(`unknown resource ${uri}: a resource is system://work/<id>`)
  return id
}

/** Serve MCP on stdio until the client closes it; resolves the exit code. */
export async function runMcp(args: string[], home: string, open: (who: Caller, onCode: (code: Code) => void) => Promise<Client>): Promise<number> {
  try {
    parseArgs({ args, options: {}, allowPositionals: false })
  } catch (error) {
    process.stderr.write(`system: mcp: ${(error as Error).message}\nusage: system mcp\n`)
    return 2
  }
  const who: Caller = { type: 'agent', operatorId: operatorId() }

  const server = new Server({ name: 'system', version: '0.0.0' }, { capabilities: { tools: { listChanged: true }, resources: { subscribe: true } }, instructions: INSTRUCTIONS })
  /** The Works the client subscribed to; each connection to the Host watches them again when it is opened. */
  const subscribed = new Set<string>()
  const heard = (method: string, params: unknown) => {
    if (method !== 'work.changed') return
    const { workId } = params as { workId: string }
    if (subscribed.has(workId)) void server.sendResourceUpdated({ uri: `system://work/${workId}` }).catch(() => {})
  }
  let current = tools
  let rows = rowsOfCode({ operations, tableOf })
  /** The Host runs newer code: list its tools; if its table cannot be read, keep the list. */
  const newCode = (code: Code) => {
    try {
      current = toolsOf(code)
      rows = rowsOfCode(code)
    } catch {
      return
    }
    void server.sendToolListChanged().catch(() => {})
  }
  const connectHost = async (): Promise<Client> => {
    const client = await open(who, newCode)
    client.onNotice(heard)
    const watches = [...subscribed].map((workId) => ({ workId }))
    await Promise.allSettled(watches.map((params) => client.call('work.watch', params)))
    return client
  }
  let session: Promise<Client> | undefined
  const link = () => (session ??= connectHost().catch((error) => { session = undefined; throw error }))
  /** A failure as the message the client reads; a lost connection is opened again by the next call. */
  const failed = (error: unknown): Error => {
    if (!(error instanceof RpcError)) session = undefined
    const failure = explain(error, home)
    if (!(failure instanceof Error)) return new Error(String(failure))
    // A lost connection says why (the Host stopped or was restarted), so a session can tell it from a Host that never ran.
    return error instanceof NotRunning && failure !== error ? new Error(`${failure.message} [${error.message}]`, { cause: error }) : failure
  }
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: current }))
  /** A closed connection; by name too, because a client of newer code (see `openCurrent`) throws that code's own NotRunning class. */
  const lost = (error: unknown) => error instanceof NotRunning || (error instanceof Error && error.constructor.name === 'NotRunning')
  /**
   * Run a Host call for a request: a failure is the request's error. A connection that was open and is found closed
   * (the Host restarted, e.g. a `system update`) is opened again, with the version handshake, and the call is sent
   * once more, but only when its repeat is idempotent: a read, or a write with a `commandId` (made before the first send; the Host answers a
   * repeat from its receipt). Any other write may have been done before the connection closed, so it reports the
   * error and the next call reconnects.
   */
  const forwarded = async (method: string, given: object): Promise<unknown> => {
    // A write that takes a `commandId` gets one here, before the first send, so that the repeat reuses it.
    const row = rows.get(method)
    const params = withCommandId(row, given, 'mcp-')
    const again = repeatable(row, params)
    let client: Client
    try {
      client = await link()
    } catch (error) {
      throw failed(error)
    }
    try {
      return await client.call(method, params)
    } catch (error) {
      if (!lost(error) || !again) throw failed(error)
      session = undefined
    }
    try {
      return await (await link()).call(method, params)
    } catch (error) {
      throw failed(error)
    }
  }
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      if (!current.some((tool) => tool.name === params.name)) throw new Error(`unknown tool ${params.name}`)
      let args = withWorkflowFile(params.name, params.arguments ?? {})
      if (params.name === 'artifact.cat' && args.maxBytes === undefined) args = { ...args, maxBytes: CAT_PART }
      const result = await forwarded(params.name, args)
      return { content: [{ type: 'text' as const, text: boundText(JSON.stringify(params.name === 'work.show' ? boundShow(result) : result) ?? 'null', params.name) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }
    }
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: ((await forwarded('work.list', {})) as { id: string; status: string }[]).map((work) => ({ uri: `system://work/${work.id}`, name: work.id, description: `Work ${work.id}: ${work.status}`, mimeType: 'application/json' })),
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
    contents: [{ uri: params.uri, mimeType: 'application/json', text: boundText(JSON.stringify(boundShow(await forwarded('work.show', { workId: workOf(params.uri) }))), 'work.show') }],
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
