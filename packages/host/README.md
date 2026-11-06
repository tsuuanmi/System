# @system/host

The Host's transport ([PROP-0004](../../docs/proposals/PROP-0004-host-design.md)
C5 and C17, [architecture](../../docs/architecture/host.md#commands)): the
socket in front of the in-process `Host` of `@system/work`. Node built-ins
only. This is the start of the API reference; the table of Work operations is
H3b.

```ts
const server = await serve(host, { path })          // Unix socket
const client = await connect(path, { timeout })     // { call(method, params), close() }
await client.call('host.hello', { version, caller: { type: 'human', operatorId } })
await client.call('host.ping')
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
- **Methods.** A table `method -> { handler, agent }`; a caller of type `agent`
  may call only rows with `agent: true`.

| Method | Agent | Result |
| --- | --- | --- |
| `host.hello` | yes | `{ version }` |
| `host.ping` | yes | `{ version, pid, works, recordBytes }`: the memory report (C18), counted from the records |

## Errors

| Code | Meaning |
| --- | --- |
| `-32700` | the line is not JSON (the connection stays open) |
| `-32600` | not a JSON-RPC 2.0 request, or a line over 1 MiB (the connection is closed) |
| `-32601` | unknown method |
| `-32602` | invalid params (a malformed hello) |
| `-32603` | the handler failed |
| `-32000` | refused: no hello yet, a version mismatch, or an operation closed to agents |

## Client

`call` rejects after `timeout` ms (default 10 s, `CALL_TIMEOUT`) with "the Host
is not answering"; `connect` rejects with "the Host is not running" on ENOENT or
ECONNREFUSED. A server error rejects with an `RpcError` carrying its `code`.

## Tests

`tests/transport.test.ts` runs over a real socket, with a Host on the
in-memory stand-ins of [test-support](../../test-support/README.md).
