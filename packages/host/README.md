# @system/host

The Host's transport (PROP-0004 ([retired](../../docs/governance/retired.md))
C5 and C17, [architecture](../../docs/architecture/host.md#commands)): the
socket in front of the in-process `Host` of `@system/work`, and the table of
operations it serves. Node built-ins only, and the zod `@system/work` exports.

```ts
const server = await serve(host, { path, methods: operations(services) })  // Unix socket
const client = await connect(path, { timeout })     // { call(method, params), close() }
await client.call('host.hello', { version, caller: { type: 'human', operatorId } })
await client.call('host.status')

// as a process (`system host`): lock taken, then the sockets at $DSH_HOME/system/host.sock and $DSH_HOME/system/operator/host.sock (ADR-0016: `operator` rows only answer on the second)
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
  Work becomes terminal, is held, or starts awaiting approval. One hook in the commit
  lane sends them, and a closed connection drops its watches. A notice only
  wakes the client, which reads `work.events` from its cursor.
- **Limit.** A line is at most 1 MiB (`MAX_FRAME`). A larger one gets
  `-32600` with `id: null`, and the Host closes the connection.
- **Handshake.** The first request must be `host.hello` with
  `{ version, caller }`, where `caller` is `{ type: "human" | "agent", operatorId }`. `version` is
  the code version (`VERSION`): a short sha256 over the built `lib/**/*.js`
  of the System packages, the bundle's `cordis.patch.yml` and the shipped UI maps (`web-driver/ui/*.yaml`, `*.json`; a map is code, WW6f), computed once when the Host starts and by each
  client for its own files. Another version is refused with an error that says
  `restart the Host: systemctl --user restart system` (or restart `system host`). When the Host runs the code on disk (`onDisk` of `serve`, the install's `current`), the client is the older side and the refusal says `the client is older: restart the client` instead (for `system mcp`, the session or its MCP server); `system mcp` itself recovers from it (see the [app README](../app/README.md)). A hello of the code on disk, while the Host is upgrading to it, gets `-32002` (`UPGRADING`) instead: retry. `connect` and `connectHello` take `retry` (ms) to wait out such a swap. While the Host waits on attempts to upgrade, a hello with `readOnly: true` of any version is answered (`readOnly: true` in the reply): that connection may call only the rows marked `read` (`Method.read`: `work.show`, `work.list`, `work.events`, `workers.list` and the other reads) and gets `-32002` naming the target code for the rest, so a client can tell a draining Host from a hung one. The CLI opens one for a read when its full hello is refused this way.
  The reply carries `packageVersion`, the `package.json` version, for display only. The caller is kept for
  the connection, passed to every handler and recorded as the `caller` of each Work event the call causes. Until a hello succeeds, any other
  method is refused.
- **Methods.** A table `method -> { params, handler, authority }`: `params` is a
  zod schema, and a call that does not fit it gets `-32602` before the handler
  runs. Every row declares its [Authority](../../GLOSSARY.md#running-and-directing-work)
  (`operator`, `caller`, or `worker`): an `operator` row refuses any caller
  other than `human` (at a terminal, per [ADR-0011](../../docs/decisions/ADR-0011-human-caller-needs-a-terminal.md))
  and is not exposed as an MCP tool, `caller` rows are open to caller sessions
  and MCP, and `worker` rows are refused on the caller socket. `approval.decide`
  also checks, in its handler, that the caller is a human.
  `operations(services)` (`src/operations.ts`) builds the rows of the Work
  operations; `Services` is what they need besides the `Host`: Artifacts,
  credentials and the Workers view; `system host` brings the DSH-backed ones.
- **Receipts.** `work.submit`, `work.run`, `work.retry`, `work.cancel`,
  `approval.decide` and `item.claim` take an optional `commandId`, which the Host core turns
  into a receipt: the same call again answers from the record, and the same
  `commandId` with other params is refused. The other mutating rows
  (`artifact.put`, `task.new`, `intent.new`, `artifact.confirm`, `defect.add`, `defect.withdraw`,
  `credentials.set`) accept a `commandId` too, so a client sends every write the same way, but
  they store by content (or set a value), so a repeat gives the same result and no receipt is kept.
- **Long calls.** `work.run`, `work.retry` and `approval.decide` answer as soon
  as the Work is held and being driven (a refusal before that, such as another
  run holding the Work, is the answer), and `work.submit` runs the Work it admits the same way unless `run` is false (the CLI sends false and follows the Work itself). None
  waits for the Work to end: follow it with `work.events` and its cursor. A
  closed connection never cancels a Work; only `work.cancel` does.

## API reference

The operation table in `src/operations.ts` is the reference: each row's name,
params schema, summary, `authority`, `read` flag and `destructive` flag (the MCP `readOnlyHint`/`destructiveHint`; `system schema` prints the table). Agents see the `caller`
rows as the `system mcp` tool descriptions; people see it in `system <command> --help`.

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
