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
  `restart the Host: systemctl --user restart system` (or restart `system host`). A hello of the code on disk, while the Host is upgrading to it, gets `-32002` (`UPGRADING`) instead: retry. `connect` and `connectHello` take `retry` (ms) to wait out such a swap. While the Host waits on attempts to upgrade, a hello with `readOnly: true` of any version is answered (`readOnly: true` in the reply): that connection may call only the rows marked `read` (`Method.read`: `work.show`, `work.list`, `work.events`, `workers.list` and the other reads) and gets `-32002` naming the target code for the rest, so a client can tell a draining Host from a hung one. The CLI opens one for a read when its full hello is refused this way.
  The reply carries `packageVersion`, the `package.json` version, for display only. The caller is kept for
  the connection, passed to every handler and recorded as the `caller` of each Work event the call causes. Until a hello succeeds, any other
  method is refused.
- **Methods.** A table `method -> { params, handler, agent }`: `params` is a
  zod schema, and a call that does not fit it gets `-32602` before the handler
  runs. A caller of type `agent` may call only rows with
  `agent: true`, and `approval.decide` also checks, in its handler, that the
  caller is a human.
  `operations(services)` (`src/operations.ts`) builds the rows of the Work
  operations; `Services` is what they need besides the `Host`: Artifacts,
  credentials and the Workers view; `system host` brings the DSH-backed ones.
- **Receipts.** `work.submit`, `work.run`, `work.retry`, `work.cancel` and
  `approval.decide` take an optional `commandId`, which the Host core turns
  into a receipt: the same call again answers from the record, and the same
  `commandId` with other params is refused. The other mutating rows
  (`artifact.put`, `task.new`) store by content, so a repeat
  gives the same Artifact.
- **Long calls.** `work.run`, `work.retry` and `approval.decide` answer as soon
  as the Work is held and being driven (a refusal before that, such as another
  run holding the Work, is the answer), and `work.submit` runs the Work it admits the same way unless `run` is false (the CLI sends false and follows the Work itself). None
  waits for the Work to end: follow it with `work.events` and its cursor. A
  closed connection never cancels a Work; only `work.cancel` does.

## API reference

<!-- api:begin: generated from the operation table; `SYSTEM_DOCS_WRITE=1 corepack pnpm test` rewrites it -->

| Method | Agent | Params | Result |
| --- | --- | --- | --- |
| `host.hello` | yes | `version: string`, `caller: { type: "human" \| "agent", operatorId: string }` | The first request of a connection: `{ version, packageVersion }`. |
| `host.status` | yes | none | Whether the Host answers, and the memory report (C18) counted from the records, for the growth budget: `{ version, pid, works, recordBytes }`. |
| `work.submit` | yes | `workflow?: string`, `uses?: object`, `capabilities?: string[]`, `input?: string`, `worker?: string`, `force?: boolean`, `run?: boolean`, `commandId?: string` | Admit a Work and run it (unless `run` is false), from the contents of a Workflow file, or a single Task by capability, and return its record; with `run` false it only admits, and `work.run` starts it later. `uses` may hold the contents of the Workflow files it uses (Sub-workflows), by file name; a file not sent is read from `workflows/` at the input Task's base commit, else beside the Host's code. They are joined into the pinned spec now. With `worker`, only that Worker may take the Worker steps of the Work; it is refused when that Worker is not registered or lacks the capabilities of a step. When the input Task names an Item that already has a running or held Work, it is refused, naming that Work and its Account, unless `force` is true. |
| `work.run` | yes | `workId: string`, `commandId?: string` | Start admitted or interrupted Work and return its record once it is running; follow it with `work.events`. |
| `work.retry` | yes | `workId: string`, `step?: string`, `worker?: string`, `reason?: string`, `commandId?: string` | Run a step of failed, cancelled or held Work again as a new attempt, and return its record once it is running; the steps after it are reset. A verify step is asked again on the same subject with the same pinned criteria, by a human caller only; its earlier verdict stays recorded and no longer counts. |
| `work.cancel` | yes | `workId: string`, `reason?: string`, `commandId?: string` | Stop Work: its record once cancelled, or `"requested"` while a run is stopping its attempt. |
| `work.show` | yes | `workId: string` | The Work record: events and state; while Worker attempts run, also `live`: per attempt its step, Worker, start, last activity, elapsed and quiet seconds, whether it is stalled, and the `progress` its Runtime last reported (turns, last tool, tokens, stage). `live` is an observation of the moment, never part of the record. |
| `work.list` | yes | none | Every Work as `{ id, status, specId }`; `status` is `admitted, not running` for a Work admitted and never run. |
| `work.replay` | yes | `workId: string` | Fold the recorded events again: `{ state, matches }`. Runs nothing. |
| `work.report` | yes | `workId: string` | Duration, attempts, time waited for a slot, rate-limited attempts, operator touches and usage of a Work, from its events. |
| `work.events` | yes | `workId: string`, `after?: integer` | The events with `seq` above `after` (all when omitted) and the current status: `{ events, status }`. Poll it to follow a Work. |
| `work.watch` | yes | `workId: string` | Keep this connection subscribed: the Host sends the notification `work.changed { workId, status, seq }` (no `id`) when the Work becomes terminal, is held, or starts awaiting approval, and `work.changed { workId, status, seq, stalled: true }` when one of its attempts has been quiet for `stallMinutes`. A notice only wakes the client: read `work.events` from your cursor. Replies `{ status, seq }` of the Work now. |
| `work.unwatch` | yes | `workId: string` | Stop the notices of `work.watch` for a Work on this connection. |
| `approval.decide` | no | `workId: string`, `decision: "approved" \| "denied"`, `reason: string`, `commandId?: string` | Record a human's decision on what held Work awaits, and continue it. Only a human caller; the CLI sends it after its terminal confirmation. |
| `task.new` | yes | `instructions: string`, `repository?: string`, `ref?: string`, `context?: string[]`, `item?: string`, `against?: string` | Store a `task@1` Artifact (and, with `repository`, the exact base commit): `{ task, base? }`. With `against`, the base is a change from that commit of `repository`, so a verifier selects checks by the files that differ between the two. With `item`, the Task names that Item of the repository's STATUS.md (see `status`); it is refused when the repository's `dev` has no line for the Item. |
| `status` | yes | `repository: string`, `state?: "todo" \| "doing" \| "done"`, `item?: string` | The status of a project: one line per Item of the repository's `STATUS.md` on its `origin/dev` tip (else `dev`), as `[x] <id> <title> - <state>`. `done`: a Work for the Item was merged into `dev` (read from the Host's store), or `[x]` in `STATUS.md` for work done outside System (with the last merged Work and Artifact IDs when known); `doing`: a Work whose Task names the Item is running or held (its ID, step, Account, since when, and its live progress, or why it is held); `todo`: nobody. `state` and `item` narrow it; STATUS.md lines that could not be read follow as `note:` lines, after one that names the ref read and how old it is. Read the Work by ID for details. |
| `item.claim` | yes | `repository: string`, `item: string`, `force?: boolean` | Claim an Item of the repository's STATUS.md before submitting a Work for it: `{ repository, item, who, at }`, with `who` the caller's operator ID. `status` then shows the Item as `doing`, claimed by `who` since `at`; a Work submitted for the Item takes the claim over. Refused when the Item has no line in STATUS.md, has a running or held Work, or is claimed by another caller, unless `force` is true. |
| `artifact.put` | yes | `data: string`, `mediaType?: string`, `classification?: "public" \| "operator-shared" \| "local-private"` | Store bytes (base64, within the frame limit) as a `file@1` Artifact: its envelope. |
| `artifact.show` | yes | `id: string` | An Artifact's envelope and occurrences, or why it is not stored. |
| `artifact.cat` | yes | `id: string` | The bytes of a blob Artifact as `{ data }` in base64; refused when they do not fit a frame. |
| `workers.list` | yes | none | The registered Workers, and each configured agent account with why it is or is not available. |
| `workers.login` | no | `ref: string`, `cookies?: string` | Sign a browser Account (`web/<site>/<name>`) in: import the contents of a cookie file, or without one open a visible window where the Host has a display. Returns whether it is signed in; no cookie value is returned. |
| `workers.loginRemote` | no | `ref: string` | Start a remote sign-in of a browser Account: its profile opens headed on a private display and a viewer is served on 127.0.0.1 behind a random token. Returns `{ url, port, ssh, expiresAt }`; the operator tunnels to the port over SSH. Follow with `workers.loginWait`. |
| `workers.loginWait` | no | `ref: string`, `cancel?: boolean` | Wait until the remote sign-in of an Account ends (Save, Cancel in the viewer, or its 15 minutes), or with `cancel` end it now. Returns whether the profile is signed in. |
| `workers.recheck` | no | `ref: string` | Recheck a browser Account that is quarantined or cooling down: its profile opens headed on a private display and the sign-in, Chat mode and temporary chat are checked; nothing is sent. Returns `{ ready, state, detail }`; the Account is `ready` again only when the check passes, and this is the only way out of `needs-sign-in` and `challenged`. |
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
