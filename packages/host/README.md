# @system/host

The Host's transport ([PROP-0004](../../docs/proposals/PROP-0004-host-design.md)
C5 and C17, [architecture](../../docs/architecture/host.md#commands)): the
socket in front of the in-process `Host` of `@system/work`, and the table of
operations it serves. Node built-ins only, and the zod `@system/work` exports.

```ts
const server = await serve(host, { path, methods: operations(services) })  // Unix socket
const client = await connect(path, { timeout })     // { call(method, params), close() }
await client.call('host.hello', { version, caller: { type: 'human', operatorId } })
await client.call('host.ping')

// as a process (`system host`): lock taken, then the socket at $DSH_HOME/system/host.sock
const serving = await serveHost({ host, home, services, log })
await serving.stop()                                // server, then the Host core and its lock
```

## Protocol

- **Framing.** [JSON-RPC 2.0](https://www.jsonrpc.org/specification), one JSON
  object per line (NDJSON), as MCP's stdio transport. Requests carry an `id`
  and may be answered out of order; the client matches them by `id`. There are
  no notifications and no batches.
- **Limit.** A line is at most 1 MiB (`MAX_FRAME`). A larger one gets
  `-32600` with `id: null`, and the Host closes the connection.
- **Handshake.** The first request must be `host.hello` with
  `{ version, caller: { type: "human" | "agent", operatorId } }`. `version` is
  the CLI package version; another version is refused with an error that says
  `restart the Host: systemctl --user restart system`. The caller is kept for
  the connection and passed to every handler. Until a hello succeeds, any other
  method is refused.
- **Methods.** A table `method -> { params, handler, agent }`: `params` is a
  zod schema, and a call that does not fit it gets `-32602` before the handler
  runs. A caller of type `agent` may call only rows with `agent: true`.
  `operations(services)` (`src/operations.ts`) builds the rows of the Work
  operations; `Services` is what they need besides the `Host`: Artifacts,
  credentials and the Workers view; `system host` brings the DSH-backed ones.
- **Authority.** The caller of the connection is passed to every handler and is
  the `caller` recorded on each Work event the call causes. An agent calling a
  row flagged `agent: false` gets `-32001`, "not allowed for agents".
  `approval.decide` also checks, in its handler, that the caller is a human.
- **Receipts.** `work.submit`, `work.run`, `work.retry`, `work.cancel` and
  `approval.decide` take an optional `commandId`, which the Host core turns
  into a receipt: the same call again answers from the record, and the same
  `commandId` with other params is refused. The other mutating rows
  (`artifact.put`, `task.new`, `conversation.add`) store by content, so a repeat
  gives the same Artifact.
- **Long calls.** `work.run`, `work.retry` and `approval.decide` answer as soon
  as the Work is held and being driven (a refusal before that, such as another
  run holding the Work, is the answer), and `work.submit` only admits. None
  waits for the Work to end: follow it with `work.events` and its cursor. A
  closed connection never cancels a Work; only `work.cancel` does.

## API reference

<!-- api:begin: generated from the operation table; `SYSTEM_DOCS_WRITE=1 corepack pnpm test` rewrites it -->

| Method | Agent | Params | Result |
| --- | --- | --- | --- |
| `host.hello` | yes | `version: string`, `caller: { type: "human" \| "agent", operatorId: string }` | The first request of a connection: `{ version }`. |
| `host.ping` | yes | none | Whether the Host answers: `{ version, pid, works, recordBytes }`. |
| `host.status` | yes | none | The memory report (C18), counted from the records: the same `{ version, pid, works, recordBytes }`, for the growth budget. |
| `work.submit` | yes | `workflow?: string`, `capabilities?: string[]`, `input?: string`, `commandId?: string` | Admit a Work from the contents of a Workflow file, or a single Task by capability, and return its record. It does not run it. |
| `work.run` | yes | `workId: string`, `commandId?: string` | Start admitted or interrupted Work and return its record once it is running; follow it with `work.events`. |
| `work.retry` | yes | `workId: string`, `step?: string`, `worker?: string`, `reason?: string`, `commandId?: string` | Run a Worker step of failed, cancelled or held Work again as a new attempt, and return its record once it is running. |
| `work.cancel` | yes | `workId: string`, `reason?: string`, `commandId?: string` | Stop Work: its record once cancelled, or `"requested"` while a run is stopping its attempt. |
| `work.show` | yes | `workId: string` | The Work record: events and state. |
| `work.list` | yes | none | Every Work as `{ id, status, specId }`. |
| `work.replay` | yes | `workId: string` | Fold the recorded events again: `{ state, matches }`. Runs nothing. |
| `work.report` | yes | `workId: string` | Duration, attempts, operator touches and usage of a Work, from its events. |
| `work.events` | yes | `workId: string`, `after?: integer` | The events with `seq` above `after` (all when omitted) and the current status: `{ events, status }`. Poll it to follow a Work. |
| `approval.decide` | no | `workId: string`, `decision: "approved" \| "denied"`, `reason: string`, `commandId?: string` | Record a human's decision on what held Work awaits, and continue it. Only a human caller; the CLI sends it after its terminal confirmation. |
| `task.new` | yes | `instructions: string`, `repository?: string`, `ref?: string`, `context?: string[]` | Store a `task@1` Artifact (and, with `repository`, the exact base commit): `{ task, base? }`. |
| `artifact.put` | yes | `data: string`, `mediaType?: string`, `classification?: "public" \| "operator-shared" \| "local-private"` | Store bytes (base64, within the frame limit) as a `file@1` Artifact: its envelope. |
| `artifact.show` | yes | `id: string` | An Artifact's envelope and occurrences, or why it is not stored. |
| `artifact.cat` | yes | `id: string` | The bytes of a blob Artifact as `{ data }` in base64; refused when they do not fit a frame. |
| `conversation.preview` | yes | `parts: { response: { name: string, data: string, mediaType: string }, prompt?: { name: string, data: string, mediaType: string }, attachments?: { name: string, data: string, mediaType: string }[] }`, `asserted?: { provider?: string, url?: string, model?: string, capturedAt?: string, selection?: "complete" \| "excerpts" \| "summary", context?: string[] }` | What would be stored of a conversation, and what looks like a secret in it. Stores nothing. |
| `conversation.add` | no | `parts: { response: { name: string, data: string, mediaType: string }, prompt?: { name: string, data: string, mediaType: string }, attachments?: { name: string, data: string, mediaType: string }[] }`, `asserted?: { provider?: string, url?: string, model?: string, capturedAt?: string, selection?: "complete" \| "excerpts" \| "summary", context?: string[] }`, `supersedes?: string[]`, `acceptWarnings?: boolean` | Store a conversation held elsewhere: `{ id }`. Refused when the preview has warnings, unless `acceptWarnings`. |
| `workers.list` | yes | none | The registered Workers, and each configured agent account with why it is or is not available. |
| `credentials.status` | no | `names: string[]` | Whether each name is configured, and from where: `{ name, configured, source? }` per name. Values never leave the Host. |
| `credentials.set` | no | `name: string`, `value: string` | Store a value under a name in the DSH credential store. Nothing returns it. |

<!-- api:end -->

## Errors

| Code | Meaning |
| --- | --- |
| `-32700` | the line is not JSON (the connection stays open) |
| `-32600` | not a JSON-RPC 2.0 request, or a line over 1 MiB (the connection is closed) |
| `-32601` | unknown method |
| `-32602` | invalid params (a malformed hello, or params that do not fit the row's schema) |
| `-32603` | the handler failed |
| `-32000` | refused: no hello yet, or a version mismatch |
| `-32001` | not allowed for agents: the operation is flagged `agent: false` |

## Client

`call` rejects after `timeout` ms (default 10 s, `CALL_TIMEOUT`) with "the Host
is not answering"; `connect` rejects with "the Host is not running" on ENOENT or
ECONNREFUSED. A server error rejects with an `RpcError` carrying its `code`.

## Tests

`tests/transport.test.ts` runs over a real socket, with a Host on the
in-memory stand-ins of [test-support](../../test-support/README.md).
`tests/operations.test.ts` does the same for the table, with fake Workers: every
method round-trips, agents are refused every `agent: false` row (it iterates the
table, so a new row is covered), and a Work outlives its client.
`tests/api.test.ts` fails when the reference above differs from the table;
`SYSTEM_DOCS_WRITE=1 corepack pnpm test` rewrites it.
