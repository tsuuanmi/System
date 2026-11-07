# @system/host

The Host's transport ([PROP-0004](../../docs/proposals/PROP-0004-host-design.md)
C5 and C17, [architecture](../../docs/architecture/host.md#commands)): the
socket in front of the in-process `Host` of `@system/work`, and the table of
operations it serves. Node built-ins only, and the zod `@system/work` exports.

```ts
const server = await serve(host, { path, methods: operations(services) })  // Unix socket
const client = await connect(path, { timeout })     // { call(method, params), close() }
await client.call('host.hello', { version, caller: { type: 'human', operatorId } })
await client.call('host.status')

// as a process (`system host`): lock taken, then the socket at $DSH_HOME/system/host.sock
const serving = await serveHost({ host, home, services, log })
await serving.stop()                                // server, then the Host core and its lock
// `served.close()` stops accepting, lets admitted calls finish for `grace` (2 s), then drops every connection
```

## Protocol

- **Framing.** [JSON-RPC 2.0](https://www.jsonrpc.org/specification), one JSON
  object per line (NDJSON), as MCP's stdio transport. Requests carry an `id`
  and may be answered out of order; the client matches them by `id`. There are
  no batches. The Host sends notifications (no `id`) only to a connection that
  called `work.watch`: `work.changed { workId, status, seq }` when a watched
  Work becomes terminal, is held, or starts awaiting approval (with `goal`:
  when a new Work of the Goal is admitted, `seq` 0). One hook in the commit
  lane sends them, and a closed connection drops its watches. A notice only
  wakes the client, which reads `work.events` from its cursor.
- **Limit.** A line is at most 1 MiB (`MAX_FRAME`). A larger one gets
  `-32600` with `id: null`, and the Host closes the connection.
- **Handshake.** The first request must be `host.hello` with
  `{ version, caller }`, where `caller` is `{ type: "human" | "agent", operatorId }`
  or `{ type: "orchestrator", operatorId, goal }` (`system mcp --goal`). `version` is
  the code version (`VERSION`): a short sha256 over the built `lib/**/*.js`
  of the System packages and the bundle's `cordis.patch.yml`, computed once when the Host starts and by each
  client for its own files. Another version is refused with an error that says
  `restart the Host: systemctl --user restart system` (or restart `system host`).
  The reply carries `packageVersion`, the `package.json` version, for display only. The caller is kept for
  the connection, passed to every handler and recorded as the `caller` of each Work event the call causes. Until a hello succeeds, any other
  method is refused.
- **Methods.** A table `method -> { params, handler, agent }`: `params` is a
  zod schema, and a call that does not fit it gets `-32602` before the handler
  runs. A caller of type `agent` or `orchestrator` may call only rows with
  `agent: true`, and `approval.decide` also checks, in its handler, that the
  caller is a human.
  `operations(services)` (`src/operations.ts`) builds the rows of the Work
  operations; `Services` is what they need besides the `Host`: Artifacts,
  credentials and the Workers view; `system host` brings the DSH-backed ones.
- **Orchestrator scope.** An `orchestrator` caller has an agent's authority and
  is further confined to its Goal (ADR-0009 decision 4). A row's optional
  `scope(host, params, caller)` runs for it before the handler: it throws
  `-32001` naming the scope, or returns the params to run with.
  - `work.submit` takes only the caller's own `goal`, and fills it in when
    absent.
  - `work.run`, `work.retry`, `work.cancel`, `work.show`, `work.events`,
    `work.report` and `work.replay` take only Works whose `admitted` event
    names the Goal or one in its supersedes chain; `work.list` shows only
    those.
  - `artifact.show` and `artifact.cat` take only Artifacts a scoped Work
    names as input, output, evidence or criteria, or as context or base of
    its Task. `goal.show` takes only the Goals of the chain.
  - Rows without a scope (`task.new`, `artifact.put`, `workers.list`,
    `conversation.preview`, `host.status`) are an agent's.
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
| `host.hello` | yes | `version: string`, `caller: { type: "human" \| "agent", operatorId: string } \| { type: "orchestrator", operatorId: string, goal: string }` | The first request of a connection: `{ version, packageVersion }`. |
| `host.status` | yes | none | Whether the Host answers, and the memory report (C18) counted from the records, for the growth budget: `{ version, pid, works, recordBytes }`. |
| `work.submit` | yes | `workflow?: string`, `capabilities?: string[]`, `input?: string`, `goal?: string`, `commandId?: string` | Admit a Work from the contents of a Workflow file, or a single Task by capability, and return its record. It does not run it. With `goal`, it counts toward that Goal and is refused once the budget of the Goal is spent. |
| `work.run` | yes | `workId: string`, `commandId?: string` | Start admitted or interrupted Work and return its record once it is running; follow it with `work.events`. |
| `work.retry` | yes | `workId: string`, `step?: string`, `worker?: string`, `reason?: string`, `commandId?: string` | Run a Worker step of failed, cancelled or held Work again as a new attempt, and return its record once it is running. |
| `work.cancel` | yes | `workId: string`, `reason?: string`, `commandId?: string` | Stop Work: its record once cancelled, or `"requested"` while a run is stopping its attempt. |
| `work.show` | yes | `workId: string` | The Work record: events and state. |
| `work.list` | yes | none | Every Work as `{ id, status, specId }`. |
| `work.replay` | yes | `workId: string` | Fold the recorded events again: `{ state, matches }`. Runs nothing. |
| `work.report` | yes | `workId: string` | Duration, attempts, operator touches and usage of a Work, from its events; for a Work of a Goal also the Goal, its budget and its spend. |
| `work.events` | yes | `workId: string`, `after?: integer` | The events with `seq` above `after` (all when omitted) and the current status: `{ events, status }`. Poll it to follow a Work. |
| `work.watch` | yes | `workId?: string`, `goal?: string` | Keep this connection subscribed: the Host sends the notification `work.changed { workId, status, seq }` (no `id`) when the Work becomes terminal, is held, or starts awaiting approval. With `goal`, instead one for each new Work of the Goal, with `seq` 0. A notice only wakes the client: read `work.events` from your cursor. Replies `{ status, seq }` of the Work now, or `{ goal }`. |
| `work.unwatch` | yes | `workId?: string`, `goal?: string` | Stop the notices of `work.watch` for a Work or a Goal on this connection. |
| `approval.decide` | no | `workId: string`, `decision: "approved" \| "denied"`, `reason: string`, `commandId?: string` | Record a human's decision on what held Work awaits, and continue it. Only a human caller; the CLI sends it after its terminal confirmation. |
| `goal.new` | no | `aim: string`, `scope: string`, `budget?: { attempts?: integer, tokens?: integer }`, `context?: string[]`, `supersedes?: string` | Store a `goal@1` the operator wrote: `{ id }`. `supersedes` names the Goal it raises or changes; without `context` the Charter is the context. Only a human caller; the CLI sends it after its terminal confirmation. |
| `goal.show` | yes | `goal: string` | A Goal, its current version (the newest that supersedes it) and the spend of the chain, folded from the Works admitted for it: `{ id, goal, current, spend }`. |
| `task.new` | yes | `instructions: string`, `repository?: string`, `ref?: string`, `context?: string[]` | Store a `task@1` Artifact (and, with `repository`, the exact base commit): `{ task, base? }`. |
| `artifact.put` | yes | `data: string`, `mediaType?: string`, `classification?: "public" \| "operator-shared" \| "local-private"` | Store bytes (base64, within the frame limit) as a `file@1` Artifact: its envelope. |
| `artifact.show` | yes | `id: string` | An Artifact's envelope and occurrences, or why it is not stored. |
| `artifact.cat` | yes | `id: string` | The bytes of a blob Artifact as `{ data }` in base64; refused when they do not fit a frame. |
| `conversation.preview` | yes | `parts: { response: { name: string, data: string, mediaType: string }, prompt?: { name: string, data: string, mediaType: string }, attachments?: { name: string, data: string, mediaType: string }[] }`, `asserted?: { provider?: string, url?: string, model?: string, capturedAt?: string, selection?: "complete" \| "excerpts" \| "summary", context?: string[] }` | What would be stored of a conversation, and what looks like a secret in it. Stores nothing. |
| `conversation.add` | no | `parts: { response: { name: string, data: string, mediaType: string }, prompt?: { name: string, data: string, mediaType: string }, attachments?: { name: string, data: string, mediaType: string }[] }`, `asserted?: { provider?: string, url?: string, model?: string, capturedAt?: string, selection?: "complete" \| "excerpts" \| "summary", context?: string[] }`, `supersedes?: string[]`, `acceptWarnings?: boolean` | Store a conversation held elsewhere: `{ id }`. Refused when the preview has warnings, unless `acceptWarnings`. |
| `workers.list` | yes | none | The registered Workers, and each configured agent account with why it is or is not available. |
| `workers.login` | no | `ref: string`, `cookies?: string` | Sign a browser Account (`chatgpt-web/<name>`) in: import the contents of a cookie file, or without one open a visible window where the Host has a display. Returns whether it is signed in; no cookie value is returned. |
| `credentials.status` | no | `names: string[]` | Whether each name is configured, and from where: `{ name, configured, source? }` per name. Values never leave the Host. |
| `credentials.set` | no | `name: string`, `value: string` | Store a value under a name in the DSH credential store. Nothing returns it. |

<!-- api:end -->

## Errors

A failed call carries a JSON-RPC code: the standard ones, `-32000` (`REFUSED`)
and `-32001` (`NOT_ALLOWED`). `src/index.ts` names each constant and says when
it is sent.

## Client

A connection the Host closes (it stopped) rejects the calls in flight and later
ones with `NotRunning`.

`call` rejects after `timeout` ms (default 10 s, `CALL_TIMEOUT`) with
`NotAnswering`, "the Host is not answering"; `connect` rejects with `NotRunning`,
"the Host is not running", on ENOENT or ECONNREFUSED. A server error rejects with an `RpcError` carrying its `code`.
