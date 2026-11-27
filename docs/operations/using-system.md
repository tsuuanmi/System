---
type: operations
status: active
reviewed: 2026-11-27
summary: Following a Work, the STATUS.md of a project, and using System from an agent.
covers: [packages/app/src/index.ts, packages/app/src/client.ts]
---

# Using System

Part of the [runbook](runbook.md).

## Following a Work, and detaching

Commands that wait follow the Work; Ctrl-C detaches without touching it, and
only `system work cancel` cancels ([app README](../../packages/app/README.md)
has the exit codes). While attempts run, `work show` prints `live`; one quiet
for `stallMinutes` (10 by default, the `work` row's config) is `stalled: true`,
a notice, not a verdict.

Tests shorten the client's waits with `SYSTEM_WAIT_RECONNECT_MS`, `SYSTEM_WAIT_RETRY_MS`,
`SYSTEM_CALL_TIMEOUT_MS` and `SYSTEM_CONNECT_RETRY_MS`, and the Host's upgrade
poll with `SYSTEM_UPGRADE_POLL_MS`; unset, the defaults apply.

## The status of a project

A repository lists its planned work in a `STATUS.md` at its root: one line per
Item, `- [ ] <id> <title>` (`- [x]` when done), with an id such as `df-3`
(Item and Blocked: [GLOSSARY](../../GLOSSARY.md)). A line that does not parse is skipped and
reported by `system status` as a `note:`. `(after: id, id)` at the end of a
line (with the colon) makes the Item Blocked until each named Item is done;
`status` then reads `todo (blocked by <ids>)`, and a cycle or an ID with no line
is a problem (`cycle: a -> b -> a`, `unknown id`). `(intent: <12 hex>)` beside it
(either order, each once) names the `intent@1` Artifact the Item carries out, by
the first 12 hex characters of its ID: `status` shows it, and `task new --item`
adds that Intent to the Task's `context` (refused when the prefix is not exactly
one stored `intent@1`). The check `statusmd` fails a change whose `STATUS.md` has
any problem; it cannot open the Artifact store, so it checks an intent prefix
only against `--intents <file>` (stored `intent@1` IDs, one per line) and
otherwise prints a `note:` that the prefixes were not checked.

```
system task new --text "..." --repo . --ref dev --item df-3   # prints the Task ID alone
system claim df-3 [--repo .] [--force]   # before a Work exists: shown as doing
system status [--repo <path>] [--state todo|doing|done] [--item <id>]
```

`status` derives each Item's state from git and the Work records ([app
README](../../packages/app/README.md)). While a Work for an Item runs or is held,
`work submit` for it is refused, naming that Work; `--force` allows parallel
work on purpose. `status` fetches `origin dev` first when the last fetch of the
repository is more than 3 minutes old (bounded to 20 s; a failed fetch is no
refusal: the `note:` line says it failed and how old the ref is). `task new --ref
<branch>` for a local branch with an `origin/<branch>` fetches it too and is
refused, naming both commits, when the branch lacks commits of the origin (use
`--ref origin/<branch>`); a failed fetch is reported on stderr as a `note:`. An
`origin/...` ref or a commit is not checked. `work report --since` with a date
that has no zone reads it as UTC and prints that instant (`sinceUtc`, and on
stderr). `task new --item` is refused when the Item has no line in
`STATUS.md` on `dev`; it and `work submit` are refused for a Blocked Item unless
`--force`. Works do not edit `STATUS.md`: done is derived.

## Using System from an agent

`system mcp` lets an agent session such as Claude Code use System's agent
operations as MCP tools. It runs without DSH and talks to the running Host, so
start the Host first, then register the server once with the `claude mcp add`
command in [Install and update](install-and-update.md#install-and-start).

A session keeps `system mcp` for days: it follows the release `current` points to, so
`system update` reaches it without a restart ([Host](../architecture/host.md)).

The server's `instructions` tell a session in any repository when to use System
and the steps. A change uses `develop.yaml`; a cleanup that keeps behaviour uses
`hygiene.yaml`.

A Workflow submitted through `work.submit` may use Sub-workflows without
sending them: the Host reads each from `workflows/` at the input Task's base
commit, else beside its own code.

`system approve` and `system deny` print, once the typed confirmation is accepted and the Host has recorded it, what was
decided (`approved ship of work:… (commit 1c2e7cda5f3b)`), then follow the Work with one line per event; Ctrl-C only
detaches. An Approval of a Gate path change is of that change's commit: a re-merge of it onto a newer `dev`
needs no new one (the merge checks still run), another commit or a `gates:` list widened since does.

The session is an agent: it may use every agent operation on every Work, store
Tasks and files, and list the Workers. It cannot approve or deny (only the operator socket
serves them, and the session does not reach it:
[ADR-0016](../decisions/ADR-0016-the-gate-is-enforced-by-reachability.md)), set
credentials, sign an account in, or merge into `main`; only a human runs
`system work retry <work> --step checks.checks` for a check that failed outside
the change. `system workers` shows an account whose quota read failed with an authentication error as
`unavailable` with the reason `signed out`; it takes no step until a later read succeeds (log in again, see
[accounts and workers](accounts-and-workers.md)). Each Work is also an MCP resource, `system://work/<id>`: subscribe
to be woken when it ends, is held, waits for approval or stalls, then read
`work.events` from your last `seq`.
