---
type: architecture
status: active
reviewed: 2026-11-06
---

# The Host

**Status:** accepted design for milestone H
([ADR-0007](../decisions/ADR-0007-one-long-lived-host.md) as amended, and
[PROP-0004](../proposals/PROP-0004-host-design.md)). **In progress.**
Implemented so far: the Host lock, the commit lane, receipts and recovery on
start, in `packages/work` (`host-lock.ts`, `lane.ts`, `host.ts`; H2), and the
socket with its operation table, in `packages/host` (H3). Not yet: the CLI
cutover (H4), parallel steps and Account slots (H5). Until release R1,
every `system` command still boots its own host, as described in
[Work ownership and recovery](work-ownership-and-recovery.md). This document
describes the target, and is updated as each step lands.

## Why

**One owner.** One process owns every Work. That ends the class of defects
that came from several short-lived processes each loading their own copy of
the store. Five were found and fixed on 2026-11-06:
- an empty lock;
- stale-lock removal moving a live lock;
- a stale snapshot overwriting events;
- SQLite store-creation races;
- the profile config rewritten under a reader.

**Parallel steps.** The same owner can then run independent steps and Works
at the same time.

## Shape

```text
 operator shell
   system <cmd>                   thin client: JSON-RPC 2.0, one message per line
        |                         (sends Workflow file contents, not paths)
   Unix socket  $DSH_HOME/system/host.sock
        |
 ┌──────────────── Host: one process per DSH_HOME, one DSH host ─────────────────┐
 │ operation table   every operation once, with an `agent` flag (agents never   │
 │                   reach approve, deny, credentials set, conversation storage) │
 │ commit lane       the only path that changes a Work: each change is one       │
 │                   event appended, with its command receipt, in one write     │
 │ scheduler    (R2) ready steps -> attempts, one slot per Account by default   │
 │ attempt runners   Runtimes, verifiers and effects run outside the lane;      │
 │                   what they return comes back through the lane as events     │
 │ recovery          on start: interrupted attempts, uncertain slots, reconcile │
 │ DSH composition   storage, Artifacts, agents, verifiers, effects (unchanged) │
 └────────────────────────────────────────────────────────────────────────────────┘
 lock: an abstract Unix socket "\0system-host:<hash of canonical DSH_HOME>"
 service: user-systemd system.service (default DSH_HOME); `system host` otherwise
```

Milestone O adds `system mcp`, an agent client of the same socket that offers
only the operations the table marks for agents.

## Parts

### Ownership and the lock

The Host binds an abstract Unix socket named after its canonical `DSH_HOME`
before it opens storage. The kernel releases the binding when the process
dies. A second Host for the same home therefore fails at once, and no lock
file can be left behind.

**Implemented (H2):** `acquireHostLock` in `host-lock.ts`; `Host.start`
takes it first and gives it back if recovery fails. Off Linux it refuses and
says so. It does not replace `FileControl` before the cutover (H4): a Host
keeps its Works' locks and cancel requests in memory (`MemoryControl`).

The old per-Work lock files, takeover mutex and write fence go away. The
first Host ignores them, and the cutover checklist deletes them.

### The commit lane

Only `WorkController` writes the Work table. Every change goes through one
ordered path: the lane. A decision there reads the latest committed state,
never a copy taken before an `await`.

- **One write per change.** The change is one event, appended together with
  the receipt of the command that caused it, in a single atomic write of
  the Work record.
- **What stays outside.** Runtimes, verifiers and effects run outside the
  lane. Their results re-enter it as events.
- **Implemented (H2):** `commitLane` (`lane.ts`) is a promise chain the Host
  hands to the controller. Each decision (taking a Work's lock, a dispatch,
  an observe, a cancel, a decision, an admission) is one section of it. A
  closed Host's lane refuses, so a late attempt writes nothing. Sections do
  not enter the lane again.
- **Why a single lane is enough.** DSH's storage domain already serializes
  writes, so one lane matches what lies beneath it.

### Commands

The transport is JSON-RPC 2.0 with NDJSON framing. DSH's webserver is
TCP-only, and DSH's own JSON-RPC server uses stdio framing.

- **Handshake.** Each connection starts with a version handshake. A CLI and
  a Host of different versions refuse each other and name the fix: restart
  the Host.
- **Caller.** Every call records its caller: human at a terminal, agent, or
  Orchestrator (milestone O).
- **Receipts.** `submit`, `run`, `retry`, `cancel` and `approve` carry a
  client `commandId`. A repeated `commandId` returns the stored result. The
  same `commandId` with different arguments is refused. A submitted Work's
  ID derives from its `commandId`.
- **Implemented (H2), in process:** each of `submit`, `run`, `retry`, `cancel`
  and `decide` takes an optional `commandId`.
  - The receipt (commandId, a hash of the canonical arguments, the Work ID and
    final status) is the optional `receipts` field of the Work record,
    written in the update of the `terminal` event (of `admitted` for a
    submit), so records written before it stay valid. A cancel that only asks
    a running Work to stop is receipted with that run's `terminal` event.
  - A repeat is answered from an index built from the records at start, so it
    survives a restart; one still running is joined.
  - A refusal has no event to travel with: it is remembered only while the
    Host runs.
  - A `run` cut short has no receipt, so after a restart the same `commandId`
    runs the Work on.
- **Implemented (H3), the socket and the operation table:** `packages/host`.
  Its README is the protocol and API reference, the latter generated from the
  table and checked by a test.
  - The transport (`index.ts`): `host.hello`, the 1 MiB frame bound and a
    dispatch table `method -> { params, handler, agent }`. Params are a zod
    schema per method; the connection's caller reaches each handler.
  - The rows (`operations.ts`): `work.*`, `approval.decide`, `task.new`,
    `artifact.*`, `conversation.*`, `workers.list`, `credentials.*` and
    `host.status`. They need the DSH-backed parts (Artifacts, credentials,
    Workers) as `Services`; the CLI brings them at H4.
  - `work.submit` takes the Workflow file's contents, never a path.
  - `work.run`, `work.retry` and `approval.decide` answer once the Work is
    being driven, through a `started` signal of the Host core, so a refusal
    still reaches the caller and a long run does not hold the call. A closed
    connection never cancels a Work.
- **Following a Work.** `work.events` takes `{ workId, after }` and returns the
  events after that `seq` with the current status. The CLI polls it every
  second. Ctrl-C detaches the client, and the Work goes on.
- **Reads.** `work show` and every other read go through the Host.
- **Approval.** Approval stays human-only. `system approve` shows the exact
  subject at a terminal, and the Host checks that subject again before it
  records the decision.

### Attempts and slots (R2)

A ready step becomes an attempt once its Account has a free slot (default 1,
set in the profile). The slot is reserved in the lane before `dispatched` is
appended, and released when `observed` or `attempt-lost` is.

Brainstorm's two proposals use different Accounts, so they run at the same
time. Steps after them in the same Work wait, as their `dependsOn` already
says.

### Start, stop and recovery

On start, before taking any command, the Host recovers:

1. An attempt that was dispatched but never observed is marked interrupted.
2. If it may still be running, its Account slot stays held until
   reconciliation settles it.
3. Effects are reconciled as they are today, by reading the remote.

**Interrupted Works do not resume by themselves.** The operator, or later an
Orchestrator, runs them again.

**Implemented (H2):** `Host.start` marks each unfinished Work's unreported
attempts `attempt-lost` and reconciles effects left `intended` or `unknown`
by reading the remote, applying nothing. `interrupted()` lists the Works
nothing is driving, and `uncertain()` the lost attempts: the place where H5
keeps their Account slot. `close()` refuses new operations and frees the home.

On stop, the Host refuses new runs and exits. Whatever was cut short is the
next start's recovery.

`host.status` reports the number of Works and the size of their records, for
PLAN's growth budget.

### Running it

`system init` installs `system.service`:
- a plain user unit, with `Restart=on-failure`;
- the PATH captured at init, so the unit finds `claude`, `codex`, `git` and
  `node`;
- lingering enabled, so the Host runs after logout.

Credentials still come from the DSH store.

The CLI pings the Host with a timeout and says which case it hit:
- not running: run `systemctl --user start system`;
- not answering: see the operations runbook, written with R1.

Other homes (tests, experiments) run `system host` in the foreground.

## Guarantees and the tests that hold them

Each guarantee has a test that would fail without it. The tests are written
before the code (Charter 12, fixture first).

| Guarantee | Test |
|---|---|
| One Host per home | Held for the lock (H2): `a second lock on the same home is refused, naming the home`, `a lock on another home is not refused`, `the home is canonical: a symlink to a held home is the same home`, `after release the home can be taken at once`, `a killed process releases the home by itself` (packages/work/tests/host-lock.test.ts); `a second Host on the same home is refused; another home is not; a closed Host frees its home` (host.test.ts). The `system host` command is H4. |
| No change from a stale copy | Held for the Host's commands (H2): `a cancel and the report of a held attempt in the same turn: both are recorded, in order, and the record replays`, `run and cancel submitted together: the cancel is decided first, so nothing is dispatched`, `two runs of one Work together: one drives it, the other is refused, nothing interleaves`, `writes of different Works never overlap: every change goes through the one lane`, `seed 1` to `seed 20: run, cancel and run again at random moments lose and repeat no event`, `the lane runs one section at a time, in order, and a failure does not block the next`, `a closed Host writes nothing, even when its attempt reports late` (host.test.ts); the controller itself by H1 in packages/work/tests/seam.test.ts. |
| The five defects of 2026-11-06 stay fixed | One regression per defect, run against the Host. Held by H1 against the controller, in the tests named in [tests/README.md](../../tests/README.md#regressions). |
| A lost reply is safe | Held in process (H2): `submitting twice with one commandId gives one Work; its ID derives from the commandId`, `submit sent twice at once gives one Work`, `the same run twice dispatches once`, `the same run sent twice while it runs joins it`, `the same commandId with different arguments is refused`, `a refusal is remembered: the same retry again gives the same error, a different one is refused`, `a receipt is stored in the Work record, in the update of the event that caused it, and survives a restart`, the two cancel receipts and `records written before receipts are still valid; a record with them is too` (host.test.ts). Over the socket (H3): `the same work.submit with the same commandId gives one Work, and another body is refused`, `the same work.run with the same commandId while it runs answers at once and drives it once` (packages/host/tests/operations.test.ts). |
| Agents cannot approve | Held (H3): `an agent connection is refused every method flagged agent: false, and only those`, which iterates the table so a new row is covered, and `approval.decide needs a human even when its row is opened to agents` (packages/host/tests/operations.test.ts); the controller refuses an agent's decision too (effects.test.ts). |
| Recovery is conservative | Held except for the slot (H2): `a Host killed mid-attempt: the new Host marks the attempt lost, does not run the Work, and an explicit run continues it`, `a Work that finished is not marked, and a held Work stays held`, `an effect left intended is reconciled on start, and an applied one is not applied again`, `an effect found absent on start is published only by an explicit run`, `an effect whose outcome stays unknown holds the Work when it is run` (host.test.ts). The slot held until reconciled: H5. |
| Version skew is caught | Held (H3a): `a Host of another version refuses the hello and names the fix` (packages/host/tests/transport.test.ts). |
| Slots hold (R2) | Two Works contend for one Account: never two attempts at once. Brainstorm's two proposals overlap in time. (H5) |

## Not here

- `system mcp` (milestone O).
- Socket activation.
- An offline doctor (until a wedged Host needs one).
- Streaming or subscriptions.
- TCP or remote access.
- Auto-resume.
- Priorities, fairness tuning and a persisted queue.
- Live plugin reload.
- Sandboxing.
- Compaction (until the memory report exceeds its budget).
