---
type: architecture
status: active
reviewed: 2026-11-07
---

# The Host

**Status:** R2 implemented
([ADR-0007](../decisions/ADR-0007-one-long-lived-host.md) as amended, and
[PROP-0004](../proposals/PROP-0004-host-design.md)). The Host lock, the commit
lane, receipts and recovery on start are in `packages/work` (`host-lock.ts`,
`lane.ts`, `host.ts`; H2), the socket with its operation table in
`packages/host` (H3), and the Host as a process with the thin CLI in
`packages/app` (H4). The old per-command mode, where every `system` command
booted its own host and coordinated through files, is gone; what it did is in
[Work ownership and recovery](work-ownership-and-recovery.md). Parallel steps
and Account slots (H5) are in `controller.ts` and `slots.ts`.

## Why

**One owner.** One process owns every Work. That ends the class of defects
that came from several short-lived processes each loading their own copy of
the store. Five were found and fixed on 2026-11-06 (listed in
[ADR-0007](../decisions/ADR-0007-one-long-lived-host.md#context)).

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
 │                   reach approve, deny, credentials set) │
 │ commit lane       the only path that changes a Work: each change is one       │
 │                   event appended, with its command receipt, in one write     │
 │ scheduler         ready steps -> attempts, one slot per Account by default   │
 │ attempt runners   Runtimes, verifiers and effects run outside the lane;      │
 │                   what they return comes back through the lane as events     │
 │ recovery          on start: interrupted attempts, uncertain slots, reconcile │
 │ DSH composition   storage, Artifacts, agents, verifiers, effects (unchanged) │
 └────────────────────────────────────────────────────────────────────────────────┘
 lock: an abstract Unix socket "\0system-host:<hash of canonical DSH_HOME>"
 service: user-systemd system.service (default DSH_HOME); `system host` otherwise
```

`system mcp` is an agent client of the same socket: a stdio MCP server that
offers only the operations the table marks for agents, and forwards each call.

## Parts

### Ownership and the lock

The Host binds an abstract Unix socket named after its canonical `DSH_HOME`
before it opens storage. The kernel releases the binding when the process
dies. A second Host for the same home therefore fails at once, and no lock
file can be left behind.

**Implemented (H2):** `acquireHostLock` in `host-lock.ts`; `Host.start`
takes it first and gives it back if recovery fails. Off Linux it refuses and
says so. A Host keeps its Works' locks and cancel requests in memory
(in the controller).

The old per-Work lock files, takeover mutex and write marks
(`$DSH_HOME/system/control/*.lock`, `*.takeover`, `*.written`) are gone from
the code (H4b-2). The Host ignores any left over and deletes none; the
[move to the install](../operations/runbook.md#moving-to-the-install-df0b) deletes
them by hand.

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
  the Host. A Host that notices new code on disk restarts itself
  ([Upgrading](#upgrading-on-new-code-d)), and a hello from the code it is
  upgrading to is refused with `-32002` (`UPGRADING`), "retry in a moment",
  which the thin client retries for a few seconds.
- **Caller.** Every call records its caller: human at a terminal or agent.
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
  Its README is the protocol (hello, 1 MiB frames, table rows, long calls) and the API reference, the latter generated from the
  table and checked by a test. `work.submit` takes the Workflow file's
  contents, never a path (`system mcp` reads a path and sends its contents;
  see [the app README](../../packages/app/README.md)), and `work.run`, `work.retry` and `approval.decide`
  answer once the Work is being driven, so a refusal still reaches the caller
  and a long run does not hold the call. A closed connection never cancels a
  Work.
- **Following a Work.** `work.events` takes `{ workId, after }` and returns the
  events after that `seq` with the current status. The CLI polls it every
  second. Ctrl-C detaches the client, and the Work goes on.
  - **Implemented (H4b-1):** the CLI is a thin client (`packages/app`:
    `remote.ts` is a `ClientHost` over the socket, `client.ts` its entry, run by
    `bin/system` for every command but `init`, `host` and `doctor`, without
    booting DSH). `buildProgram` is its commands; `doctor` and `host` are a program of their own (`buildHostProgram`), run in the DSH process.
  - It reads the Workflow file and sends its contents. A call that changes
    something carries a fresh `commandId`, sent once more with the same one
    after a timeout (10 s: "not answering").
  - Following, exit codes (0, 1, 3, 5), Ctrl-C detaching (or
    `--cancel-on-interrupt`) and the "not running" line are in the
    [runbook](../operations/runbook.md#following-a-work-and-detaching).
  - `approve` and `deny` keep the terminal confirmation and send
    `approval.decide` after it, on a connection whose caller is human.
  - `doctor` still boots DSH and also reports whether a Host answers.
- **Watching a Work (O3).** `work.watch` subscribes the connection to the
  notice `work.changed { workId, status, seq }` (protocol in the package
  README). One change hook (`Host.onChange`) is called in the commit lane after
  each append and admission, and nothing polls storage. A notice only wakes the
  client; the log is the truth, so a notice sent while it was away loses
  nothing, and a watch on a Work that already ended replies with its final
  `{ status, seq }`. `system mcp` turns it into MCP resource subscriptions (the
  [runbook](../operations/runbook.md#using-system-from-an-agent)).
- **Reads.** `work show` and every other read go through the Host.
- **Approval.** Approval stays human-only. `system approve` shows the exact
  subject at a terminal, and the Host checks that subject again before it
  records the decision.

### Attempts and slots

A ready step (pending, every `dependsOn` succeeded) becomes an attempt once its
Account has a free slot. The slot is reserved in the lane before `dispatched`
is appended, and released when `observed` or `attempt-lost` is.

Routing takes, among the capable Accounts **with a free slot**, the one with
the most quota headroom (the primary while under the ceiling; rules in the
[agents README](../../packages/agents/README.md#routing-by-headroom)); a full
Account is passed over (its candidate reason is `capable; no free slot`). The
step waits when every capable Account is full, or over the quota ceiling
(`waiting: quota`, no attempt spent), and each candidate's reason records the
reading used. `dispatched` then
carries `waitedMs`, the time the step waited (for an Account slot or a check
slot), and `observed` carries `limited` when the attempt failed because its Account
is out of quota or credits (the reasons are listed in
[limits.ts](../../packages/work/src/limits.ts)). That is not a step failure:
the Account's quota reading is read again at once, the step goes back to
pending and is dispatched again by routing on another Account, without
spending an attempt or retry, or waits (`waiting: quota`) when none is left.
Old records carry `rateLimited` on a failed step, which stays failed.
`system work report` sums the waits and limits as `waitedForSlotMs` and
`rateLimitedAttempts`. The wait is measured in the Host's memory, so a Host
restart starts it again. The report also classes each failure as an Outside
failure or a failure of the change, from the recorded reason
([GLOSSARY](../../GLOSSARY.md); patterns in
`packages/work/src/outside.ts`).

Brainstorm's two proposals use different Accounts, so they run at the same
time. Steps after them in the same Work wait, as their `dependsOn` already
says.

**Implemented (H5, R2):**
- **Drive.** A Work's `drive` (`controller.ts`) dispatches every ready step
  whose Account has a free slot, in Workflow file order, then waits for an
  attempt to report or a slot to be freed. Works are separate drives. Each
  decision is still one lane section over the latest committed record.
- **Account.** A Worker's `ref`. Its limit is `maxConcurrentAttempts` in the
  `agents` row config (per Account, or one default for all; default 1).
  Verifier and effect steps take no slot.
- **Waiting.** Ready steps without a slot wait in memory. A freed slot wakes the
  waiting Works in admission order. No priorities, fairness tuning or queue on
  disk.
- **Stopping.** A cancel, a failed step or an unknown effect stops new
  dispatches; attempts in flight are aborted (a cancel) or finish and are
  recorded, then the terminal event follows.
- **Uncertain attempts.** On start each lost Worker attempt keeps its slot, over
  the limit if need be (`host.slots.uncertain()`). `settle()` asks the Account's Worker
  `gone(attemptId)` and frees the slot if it is true. Start calls it, and so does
  a waiting Work with nothing of its own running. An agent attempt is gone when
  its pid file is absent or names no live process; a Worker without `gone` is
  never confirmed.

### Start, stop and recovery

On start, before taking any command, the Host recovers:

1. An attempt that was dispatched but never observed is marked interrupted.
2. If it may still be running, its Account slot stays held until
   `settle()` confirms its process gone.
3. Effects are reconciled as they are today, by reading the remote.

**A Worker attempt cut short is dispatched again by the Host once `settle()` confirms its process gone.** A Worker attempt runs in its own worktree with no external effect, so running it again repeats no unknown side effect. The lost attempt stays recorded and the new one is a new attempt. Every other interrupted Work waits for the operator, or an agent session, to run it: one with a verifier run lost, an effect left `intended`, `absent` or `unknown`, or a lost attempt whose process is not confirmed gone. A held Work stays held.

**Implemented (sc-8):** after recovery `Host.start` runs again, without waiting, each Work whose lost attempts are all Worker attempts confirmed gone by `slots.settle()` and whose effects are all `applied` or `failed` (the Work is not terminal, so a held one stays held).

**Implemented (H2):** `Host.start` marks each unfinished Work's unreported
attempts `attempt-lost` and reconciles effects left `intended` or `unknown`
by reading the remote, applying nothing. `slots.uncertain()` lists the lost Worker attempts that keep
their Account slot (H5). `close()` refuses new operations and frees the home.

On stop, the Host refuses new runs and exits. Whatever was cut short is the
next start's recovery. It stops accepting, lets admitted calls finish for a
short grace (2 s), then drops every connection, so a client that stays
connected never keeps it from stopping.

### Upgrading on new code (D)

After a merge the code on disk is newer than the code a Host runs, and every
new client is refused. The Host restarts itself, and never interrupts an
attempt to do it.

- **Noticing.** A timer (`UPGRADE_POLL`, 10 s) recomputes the code-version hash,
  a few hundred small files, of the code it was started as: an install's
  `current` link (`SYSTEM_CODE`), so `system update` switching it is new code,
  or the checkout. Not `fs.watch`: a build deletes and rewrites
  `lib/`, which loses watches on Linux, and it needs a debounce anyway. A
  change counts when two looks in a row find the same new hash, so a build
  still writing its files does not restart the Host, and never while the
  build's `.building` marker exists (a pause between two packages' compiles
  could look stable). A hello from a client
  whose version differs from the Host's asks the disk at once, and the Host
  upgrades if the disk's hash is that client's, unless a build runs: the
  common idle case waits for no timer.
- **Upgrading.** The Host logs why, stops dispatching new attempts (worker,
  verifier and effect; accepting a Work is none) and lets the running ones
  finish. `work.submit` and `work.run` are still accepted, so clients see
  only a delay; the runs wait at the gate.
- **Leaving.** With no attempt running, the Host stops accepting, writes the
  IDs of the Works whose runs it held to `$DSH_HOME/system/upgrade.json`,
  releases the lock and exits with status 75. A SIGTERM meanwhile wins: exit 0
  and no file. A process still alive `EXIT_GRACE` (10 s) after any stop is
  made to exit with that status and logs what is still open
  (`process.getActiveResourcesInfo()`): once, a stopped Host held its
  supervisor for an hour (2026-11-08).
- **Restart.** The unit has `Restart=on-failure`, `RestartForceExitStatus=75`,
  `RestartSec=5` and at most 10 starts in 5 minutes; `system host --supervise`
  re-executes the Host after 75, and a failure after an upgrade three times
  more, after 2, 4 and 8 s. The new Host recovers as on any start, and then reads and deletes the
  file: it runs those Works, except any with an attempt it just marked lost,
  finished ones, and ones already driven. What was interrupted is not resumed
  here: recovery (above) runs a settled Worker attempt again, and anything else
  waits for an explicit run; a Work that was only held at the gate has nothing
  in flight to interrupt. The file is one use, not a queue.
- **Clients.** The thin client retries the connection, and a hello refused as
  upgrading, for 3 s before it says "not running", and a client following a
  Work opens a closed connection again once.

`host.status` reports the number of Works and the size of their records, for
PLAN's growth budget.

### Running it

`system init` installs `system.service`, a plain user unit with
`Restart=on-failure` and `RestartForceExitStatus=75`, the PATH captured at
init, and lingering enabled. `system host` builds the Host core in the DSH
composition (`WorkService.startHost`) and serves the operation table on
`$DSH_HOME/system/host.sock`; SIGTERM or SIGINT closes the server, then the
core, and exits 0. Starting, stopping, other homes and the "not running" and
"not answering" cases are in the [operations runbook](../operations/runbook.md).

## Guarantees and the tests that hold them

Each guarantee has a test that would fail without it. The tests are written
before the code (Charter 12, fixture first).

| Guarantee | Test |
|---|---|
| One Host per home (ends the empty lock and stale-lock removal of 2026-11-06: no lock file exists to be empty, stale or moved) | Held for the lock (H2): `a second lock on the same home is refused, naming the home`, `a lock on another home is not refused`, `the home is canonical: a symlink to a held home is the same home`, `after release the home can be taken at once`, `a killed process releases the home by itself` (packages/work/tests/host-lock.test.ts). `system host` (H4a): `host-process.test.ts`, which also holds `the Host ignores the control files of the old mode and leaves them where they are; it makes no control directory` (H4b-2). |
| No change from a stale copy (ends the stale snapshot of 2026-11-06: one process loads the store, so no second copy exists) | Held for the Host's commands (H2): `no copy of the store outlives its Host: a second Host is refused while one runs a Work, and the next one starts from what the first wrote`, `a cancel and the report of a held attempt in the same turn: both are recorded, in order, and the record replays`, `run and cancel submitted together: the cancel is decided first, so nothing is dispatched`, `two runs of one Work together: one drives it, the other is refused, nothing interleaves`, `writes of different Works never overlap: every change goes through the one lane`, `seed 1` to `seed 20: run, cancel and run again at random moments lose and repeat no event`, `the lane runs one section at a time, in order, and a failure does not block the next`, `a closed Host writes nothing, even when its attempt reports late` (host.test.ts); the controller itself by H1 in packages/work/tests/seam.test.ts. |
| The five defects of 2026-11-06 stay fixed | The empty lock, stale-lock removal and the stale snapshot are the first two rows. The SQLite store-creation race and the profile config rewrite are in [tests/README.md](../../tests/README.md#regressions) (`concurrency.test.ts`, run through the Host). |
| A lost reply is safe | Held in process (H2): `submitting twice with one commandId gives one Work; its ID derives from the commandId`, `the same run twice dispatches once`, `the same commandId with different arguments is refused`, `a refusal is remembered: the same retry again gives the same error, a different one is refused`, `a receipt is stored in the Work record, in the update of the event that caused it, and survives a restart`, the two cancel receipts and `records written before receipts are still valid; a record with them is too` (host.test.ts). Over the socket (H3): `the same work.submit with the same commandId gives one Work, and another body is refused`, `the same work.run with the same commandId while it runs answers at once and drives it once` (packages/host/tests/operations.test.ts). |
| Agents cannot approve | Held (H3): `an agent connection is refused every method flagged agent: false, and only those`, which iterates the table so a new row is covered, and `approval.decide needs a human even when its row is opened to agents` (packages/host/tests/operations.test.ts); the controller refuses an agent's decision too (effects.test.ts). |
| Recovery is conservative for effects and unknown side effects; a settled Worker attempt is dispatched again | Held (H2, and the slot at H5, see the next row): `a lost Worker attempt confirmed gone at start is dispatched again without work run`, `a lost Worker attempt not confirmed gone is not dispatched again`, `replay is deterministic after automatic re-dispatch and another Host restart adds no event`, `a settled Worker attempt with an effect found absent at start is not dispatched again`, `a lost check (verifier) attempt confirmed gone at start is not dispatched again`, `a Work that finished is not marked, and a held Work stays held`, `an effect left intended is reconciled on start, and an applied one is not applied again`, `an effect found absent on start is published only by an explicit run`, `an effect whose outcome stays unknown holds the Work when it is run` (host.test.ts). The slot held until settled: `a Host killed with two attempts in flight: both are lost, their slots are held until settled, and nothing is dispatched by itself` and `a lost attempt whose Worker cannot confirm it gone keeps its slot` (packages/work/tests/slots.test.ts). |
| New code replaces the Host without interrupting an attempt | Held (D): `a draining Host starts no new attempt, lets the running one finish, and names the Works it held`, `resume continues what a draining Host held, and nothing that start found interrupted` (packages/work/tests/upgrade.test.ts); `on new code a supervised Host starts nothing new, finishes its attempt, exits 75, and the next Host serves the new version and runs what was queued` (which includes a client call during the swap), `a client built from the new code upgrades an idle Host at once, and is told to retry`, `a change seen once is not enough...`, `a stop while the Host drains exits 0 and leaves nothing to continue`, `a connection retries while the Host is away...` (packages/host/tests/upgrade.test.ts); `the supervisor runs the Host again after exit 75 and after nothing else` (packages/app/tests/service.test.ts). |
| Version skew is caught | Held (H3a): `a Host of another version refuses the hello and names the fix` (packages/host/tests/transport.test.ts). |
| Slots hold (R2) | Held (H5), in packages/work/tests/slots.test.ts: `Brainstorm: idea-a (Claude) and idea-b (Codex) are in execute at once`, `a synthesis step waits for both proposals`, `two Works on one Account never run two attempts at once with a limit of 1`, `two Works on one Account run two attempts at once with a limit of 2`, `a waiting step goes in Work admission order when its slot frees`, `a step whose first capable Account is full goes to the next capable Account with a free slot, and the record says why`, `a step waits when every capable Account is full; the time it waited is recorded and summed by the report`, `a cancel while two attempts run records both, then one terminal event`, and `seed 1` to `seed 50: three concurrent Brainstorms with random delays replay exactly, losing and repeating no event` (also never above the limit). Through the process: `the two proposals overlap in time: both are dispatched before either is observed, and the synthesis waits for both` (tests/brainstorm.test.ts). The agent side: `the account's slots are the Host's: the worker offers its limit and never queues attempts itself` and `a lost attempt is gone when its pid file is absent or names no process, and not while the process runs` (packages/agents/tests/agent.test.ts). |

## Not here

Socket activation; an offline doctor (until a wedged Host needs one); TCP or
remote access; auto-resume; priorities, fairness tuning and a persisted queue;
live profile and plugin reload; sandboxing; idle shutdown; compaction (until
the memory report exceeds its budget). Subscriptions exist only as O3's
notices above.
