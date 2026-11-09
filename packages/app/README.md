# @system/app

The `system-app` row of the [System bundle](../bundle/README.md), and the
thin client of the [Host](../host/README.md). `doctor` and `host` run in the
row: it reads the launcher's inner arguments through
`@deepseek-ai/dsh-cmdline`, runs one command once DSH has started
(`ctx.appReady`), and exits through `ctx.appExit`. Every other command runs in
`lib/client.js`, which `bin/system` loads without booting DSH: it connects to
`$DSH_HOME/system/host.sock` and calls the Host's operations. Without a Host it
prints `system: the System Host is not running for <home>: ...` and exits 1.

| Command | Result |
|---|---|
| `system doctor [--json]` | which rows are mounted, a write/read probe of the SQLite storage domain `system_doctor`, and whether a Host answers on the socket (reported, not a failure); exit 0 when every required row is mounted and the probe passes, 1 otherwise |
| `system host` | run as the Host of this home: serve the operation table on `$DSH_HOME/system/host.sock` until SIGTERM or SIGINT, then stop and exit 0, or until the code on disk changes, then finish the running attempts and exit 75 (`--supervise`, handled by `bin/system`, runs it again after 75; see [Upgrading](../../docs/operations/runbook.md#upgrading)); one line to stderr at start and stop; a second one on the same home fails with the lock's message (see the [runbook](../../docs/operations/runbook.md)) |
| `system mcp` | a stdio MCP server for an agent client such as Claude Code: one tool per operation the Host flags `agent: true`, each forwarded to the Host; the initialize result carries `instructions` (in [src/mcp.ts](src/mcp.ts)) that tell a session how to use System; each Work is a resource `system://work/<id>` (read: `work.show`) that can be subscribed to, and the Host's [`work.changed`](../host/README.md#protocol) becomes `notifications/resources/updated` (see the [runbook](../../docs/operations/runbook.md#using-system-from-an-agent)); a session outlives `system update`, so when the Host refuses this process's code, it says hello again with the client of the code under `$SYSTEM_CODE` (the install's `current` link) and continues, without the session restarting (`openCurrent` in [src/client.ts](src/client.ts); a re-exec could not hand over the stdio transport, and the thin client speaks the same protocol). Its tool list stays that of the old code until the session restarts |
| `system artifact put <file> [--media-type t] [--classification c]` | store the file as a `file@1` Artifact (default `local-private`, producer the operator) and print its ID |
| `system artifact show <id>` | the envelope and occurrences as JSON; exit 1 when missing |
| `system artifact cat <id>` | the bytes; exit 1 when unavailable |
| `system approve <workId...> [--reason r]` | approve what held Work awaits (an effect needing approval, an inconclusive verdict, `approval: operator`) and run it on; a human at a terminal must type the Work ID's first 8 characters; given several Works, it lists them and asks for one confirmation, typing `approve <n>` (`deny <n>`), then decides each in order (a Work that cannot be decided is reported on stderr and the exit status is the first non-zero) |
| `system deny <workId...> --reason r` | deny it; the Work fails. Same terminal confirmation |
| `system task new (--text t \| --file f) [--repo path [--ref r [--against c]]] [--context id...] [--item id]` | store a `task@1` input; with `--repo`, first the exact base commit as `git-tree@1`; each `--context` is a stored Artifact (such as a conversation) the Worker reads as data, not instructions; `--against` records the commit `--ref` is a change from (the base's `parent`; `system update` uses it, so a release is checked by what changed since the running one); `--item` names the Item of the repository's `STATUS.md` the task is for (`task@1` `item`); refused without `--repo` or when `dev` has no line for it; stdout is the Task ID alone, the base commit's ID is a line `base <id>` on stderr |
| `system claim <item> [--repo path] [--force]` | claim an Item of the repository's `STATUS.md` before submitting a Work for it (`item.claim`, also an MCP tool): `status` shows it as `doing`, claimed by the caller's operator ID since when, until a Work for the Item is submitted, which takes the claim over; refused when the Item has no line, has a running or held Work, or another caller claimed it (`--force` takes it over) |
| `system status [--repo path] [--state todo\|doing\|done] [--item id]` | the status of a project (default: the current directory's repository): one line per Item of `STATUS.md` on its `origin/dev` tip (else `dev`), `[x] <id> <title> - done` (a Work for it was merged into `dev`, or `[x]` in `STATUS.md`; with the last merged Work and Artifact IDs), `doing` (the Work, its step, Account, since when, and its live progress or why it is held) or `todo: nobody`; lines of `STATUS.md` that could not be read follow as `note:`. Read-only (`status`); a `done` Item whose merge commit is not in the running release says `done, not yet released` |
| `system conversation show <id>` | the notice, what the operator asserted, and the parts; exit 1 when it is not a stored conversation |
| `system workers` | registered Workers, and each agent account with its CLI version or why it is unavailable; the line ends with its runtime in parentheses, which `tools/web-canary` reads |
| `system workers login <ref> [--cookies <file> \| --remote]` | sign a `web` account in, by a cookie file (read here, sent to the Host), a viewer reached through an SSH tunnel (`--remote`: prints the `ssh -L` line and the URL, waits for Save, Ctrl-C cancels), or a window on the Host's display; then report the signed-in state, never a cookie. Operators only (`workers.login`, `workers.loginRemote`, `workers.loginWait`); through the `webWorker` service, so with the web-worker row off it says "the web-worker row is disabled" |
| `system workers recheck <ref>` | check a `web` account that is quarantined or cooling down (sign-in, Chat mode, temporary chat; nothing is sent) and make it `ready` only when the check passes; exit 1 when it does not. Operators only (`workers.recheck`); with the web-worker row off it says "the web-worker row is disabled" |
| `system credentials set <NAME>` | read a value without echo (or from piped stdin) and store it in `$DSH_HOME/.credentials.yaml` through the DSH credential API; other entries are kept |
| `system credentials status <NAME...>` | `configured (<source>)` or `not configured` per name, never the value; exit 1 if any is missing |
| `system work submit (--workflow <file> \| --capability <name...>) [--input <id>] [--worker <ref>] [--force] [--no-run] [--cancel-on-interrupt]` | admit Work from a Workflow file (read here, sent as contents with every Workflow file it uses that sits beside it; the Host reads any other from `workflows/` at the input Task's base commit, else its own) or as a direct Task, print its ID, then follow it in the Host until terminal; with `--worker` only that Worker may take its Worker steps (refused at admission when it is not registered or lacks a step's capabilities); a Work whose input Task names an Item that already has a running or held Work is refused, naming that Work and its Account, unless `--force` |
| `system work cancel <workId> [--reason r] [--wait]` | stop Work: a running attempt gets SIGTERM, SIGKILL after 30 s, and the Host records the outcome (with `--wait`, follow it until then). Partial output is kept, unaccepted |
| `system work retry <workId> [--step id] [--worker ref] [--reason r] [--cancel-on-interrupt]` | run a step of failed, cancelled or held Work again as a new attempt (default: the first Worker step that did not succeed), optionally by one named Worker, starting from the last attempt's partial output; every later step is reset. A verify step (`--step checks.checks`) is asked again on the same subject and pinned criteria, by a human only, and its earlier verdict stays recorded |
| `system work run <workId> [--cancel-on-interrupt]` | advance admitted or interrupted Work in the Host, following it until terminal |
| `system work wait <workId...> [--any] [--timeout <minutes>]` | return when every named Work, or with `--any` the first, has ended, is held or awaits approval; prints one line per Work (`<id>  <status>  <reason>`, a held Work without a reason says `awaiting <step>`) and exits with the code of the Work that decided it (with `--any` the first to end; otherwise the worst among the Works: failed, cancelled, held, succeeded): 0 succeeded, 1 failed, 3 held, 5 cancelled; **4 on timeout** (the Works are printed as they are and stderr says it timed out). Reads only, over the read-only connection when the Host is upgrading, with the polling of `work run`. Meant to be run as a background command by a session, since MCP notices do not wake an idle one; it reconnects and keeps waiting across a Host restart for up to `RECONNECT_MS` (5 minutes) |
| `system work show <workId>` | the record (events and state) as JSON |
| `system work list` | ID, status and pinned spec of every Work |
| `system work report <workId>` | duration, attempts, time waited for a slot, rate-limited attempts, operator touches (human cancels, retries, decisions) and usage (fresh input, cache read, cache write, output), with unreported usage counted apart |
| `system work replay <workId>` | fold the events again and compare with the stored state; runs nothing; exit 1 on mismatch |
| `system --help` | help, exit 0 |

`work submit`, `run`, `retry`, `approve`, `deny` and `cancel --wait` return when the Work is terminal, polling `work.events` every second. Ctrl-C **detaches**: it prints `detached; <work> goes on in the Host` and exits 0; with `--cancel-on-interrupt` it cancels the Work and follows it to its end. A call that changes something carries a fresh `commandId`, sent once more with the same one after a 10 s timeout. `approve` and `deny` ask a human at a terminal to type the exact prefix, then send `approval.decide` as a human. An error is one line, `system: <message>`; `SYSTEM_DEBUG=1` adds the stack.

Work exit codes: `0` succeeded, `1` failed or refused, `3` held for the
operator, `4` not terminal, `5` cancelled. Each call records its caller: `human` when stdin is
a terminal, otherwise `agent`, unless `SYSTEM_CALLER` says `human` or `agent`.

- [src/index.ts](src/index.ts) — the Cordis plugin: wiring to DSH services for
  `doctor` and `system host`, which are the only commands of its program
  (`HostProcess`). It runs no Work itself.
- [src/cli.ts](src/cli.ts) — the commander programs: `doctor` and `host`, and
  the thin client's commands over a `ClientHost`.
- [src/remote.ts](src/remote.ts) — the `ClientHost` over the Host's socket;
  [src/client.ts](src/client.ts) — the entry `bin/system` runs for it;
  [src/mcp.ts](src/mcp.ts) — `system mcp`;
  [src/io.ts](src/io.ts) — caller, secrets, confirmation and error lines.
- [src/doctor.ts](src/doctor.ts) — the checks, behind a `DoctorHost` seam so
  [tests](tests/README.md) need no host.

The operator ID is `SYSTEM_OPERATOR_ID`, or the OS user name when unset.

Built with `corepack pnpm build` into `lib/`, which the profile loads.
