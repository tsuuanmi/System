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
| `system mcp [--goal <id>]` | a stdio MCP server for an agent client such as Claude Code: one tool per operation the Host flags `agent: true`, each forwarded to the Host; each Work in scope is a resource `system://work/<id>` (read: `work.show`) that can be subscribed to, and the Host's [`work.changed`](../host/README.md#protocol) becomes `notifications/resources/updated` (with `--goal`, a new Work of the Goal is `resources/list_changed`); with `--goal` the caller is an Orchestrator scoped to that Goal by the Host (see the [runbook](../../docs/operations/runbook.md#using-system-from-an-agent)) |
| `system artifact put <file> [--media-type t] [--classification c]` | store the file as a `file@1` Artifact (default `local-private`, producer the operator) and print its ID |
| `system artifact show <id>` | the envelope and occurrences as JSON; exit 1 when missing |
| `system artifact cat <id>` | the bytes; exit 1 when unavailable |
| `system approve <workId> [--reason r]` | approve what held Work awaits (an effect needing approval, an inconclusive verdict, `approval: operator`) and run it on; a human at a terminal must type the Work ID's first 8 characters |
| `system deny <workId> --reason r` | deny it; the Work fails. Same terminal confirmation |
| `system task new (--text t \| --file f) [--repo path [--ref r]] [--context id...]` | store a `task@1` input; with `--repo`, first the exact base commit as `git-tree@1`; each `--context` is a stored Artifact (such as a conversation) the Worker reads as data, not instructions |
| `system goal new --aim t --scope t [--attempts n] [--tokens n] [--supersedes id] [--context id...]` | store a `goal@1` and print its ID; a human at a terminal must type the 8-character code printed with the Goal. `--supersedes` raises or changes an earlier Goal, and only its newest version (the chain stays linear); without `--context` the Charter is stored and used |
| `system goal show <id>` | the Goal, its current version (the newest that supersedes it) and the spend of its Works, as JSON |
| `system goal brief <id>` | what a new Orchestrator session starts from, as text written from records only (no model call): the Goal and its budget left, its Works with status, current step and live progress, its decisions, and what waits; the same records give the same text |
| `system decision add --goal id --question t --option t... --choice t --reason t [--rests-on id...]` | record a `decision@1` for a Goal (the choice must be one of the options) and print its ID; a record, never an authority |
| `system decision list [--goal id]` | the decisions of a Goal and its chain (of every Goal without `--goal`), oldest first, as JSON |
| `system conversation add --response f [--prompt f] [--attach f...] [--provider p] [--url u] [--model m] [--captured-at t] [--selection s] [--product-context c...] [--supersedes id...] [--yes [--accept-warnings]]` | preview a conversation held elsewhere (sizes, first lines, secret warnings; nothing stored); with `--yes`, store it as `conversation@1` and print its ID, but refuse (exit 1) when the preview has warnings unless `--accept-warnings` is also given |
| `system conversation show <id>` | the notice, what the operator asserted, and the parts; exit 1 when it is not a stored conversation |
| `system workers` | registered Workers, and each agent account with its CLI version or why it is unavailable; the line ends with its runtime in parentheses, which `tools/web-canary` reads |
| `system workers login <ref> [--cookies <file> \| --remote]` | sign a `chatgpt-web` account in, by a cookie file (read here, sent to the Host), a viewer reached through an SSH tunnel (`--remote`: prints the `ssh -L` line and the URL, waits for Save, Ctrl-C cancels), or a window on the Host's display; then report the signed-in state, never a cookie. Operators only (`workers.login`, `workers.loginRemote`, `workers.loginWait`); through the `webWorker` service, so with the web-worker row off it says "the web-worker row is disabled" |
| `system workers recheck <ref>` | check a `chatgpt-web` account that is quarantined or cooling down (sign-in, Chat mode, temporary chat; nothing is sent) and make it `ready` only when the check passes; exit 1 when it does not. Operators only (`workers.recheck`); with the web-worker row off it says "the web-worker row is disabled" |
| `system credentials set <NAME>` | read a value without echo (or from piped stdin) and store it in `$DSH_HOME/.credentials.yaml` through the DSH credential API; other entries are kept |
| `system credentials status <NAME...>` | `configured (<source>)` or `not configured` per name, never the value; exit 1 if any is missing |
| `system work submit (--workflow <file> \| --capability <name...>) [--input <id>] [--goal <id>] [--worker <ref>] [--no-run] [--cancel-on-interrupt]` | admit Work from a Workflow file (read here, sent as contents with every Workflow file it uses, read from beside it) or as a direct Task, print its ID, then follow it in the Host until terminal; with `--worker` only that Worker may take its Worker steps (refused at admission when it is not registered or lacks a step's capabilities) |
| `system work cancel <workId> [--reason r] [--wait]` | stop Work: a running attempt gets SIGTERM, SIGKILL after 30 s, and the Host records the outcome (with `--wait`, follow it until then). Partial output is kept, unaccepted |
| `system work retry <workId> [--step id] [--worker ref] [--reason r] [--cancel-on-interrupt]` | run a step of failed, cancelled or held Work again as a new attempt (default: the first Worker step that did not succeed), optionally by one named Worker, starting from the last attempt's partial output; every later step is reset. A verify step (`--step checks.checks`) is asked again on the same subject and pinned criteria, by a human only, and its earlier verdict stays recorded |
| `system work run <workId> [--cancel-on-interrupt]` | advance admitted or interrupted Work in the Host, following it until terminal |
| `system work show <workId>` | the record (events and state) as JSON |
| `system work list` | ID, status and pinned spec of every Work |
| `system work report <workId>` | duration, attempts, operator touches (human cancels, retries, decisions) and usage (fresh input, cache read, cache write, output), with unreported usage counted apart; for a Work of a Goal also the Goal's budget and spend |
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
