---
type: architecture
status: active
reviewed: 2026-11-06
---

# The Host

**Status:** accepted design for milestone H
([ADR-0007](../decisions/ADR-0007-one-long-lived-host.md) as amended, and
[PROP-0004](../proposals/PROP-0004-host-design.md)). It is **not implemented
yet**. Until release R1, every `system` command still boots its own host, as
described in [Work ownership and recovery](work-ownership-and-recovery.md).
This document describes the target, and is updated as each step lands.

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
- **Following a Work.** `work.events` takes a cursor. The CLI polls it every
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

| Guarantee | Test (planned) |
|---|---|
| One Host per home | A second `system host` on the same home exits at once. A killed Host's home can be taken immediately. |
| No change from a stale copy | A deterministic fixture (barriers, seeded delays) in which two commands race on one Work: the events equal the fold, and none are lost. Covered by H1: `a cancel request while an attempt is held at a barrier is recorded after the attempt` and `seed 1` to `seed 50` (packages/work/tests/seam.test.ts); the Host's command race itself comes with H2. |
| The five defects of 2026-11-06 stay fixed | One regression per defect, run against the Host. Held by H1 against the controller, in the tests named in [tests/README.md](../../tests/README.md#regressions). |
| A lost reply is safe | Each command is sent twice with the same `commandId`: one Work, one event. With different arguments it is refused. |
| Agents cannot approve | Every operation not flagged `agent` is refused to an agent caller. |
| Recovery is conservative | The Host is killed mid-attempt. On restart, the Work is interrupted, the slot is held until reconciled, and nothing is re-dispatched by itself. |
| Version skew is caught | A client and a Host of different versions refuse to talk. |
| Slots hold (R2) | Two Works contend for one Account: never two attempts at once. Brainstorm's two proposals overlap in time. |

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
