# @system/work

The `work` row: durable Work, the Workflow file compiler and the generic Work
Controller ([ADR-0002](../../docs/decisions/ADR-0002-work-primitive-configured-workflows.md),
[ADR-0004](../../docs/decisions/ADR-0004-mvp-0-operating-decisions.md) decision 9,
[architecture](../../docs/architecture/workflow-composition.md)).

- **Injects:** `storageDomain`, `artifacts`. **Provides:** `ctx.capabilities`
  (the Worker and verifier registry) and `ctx.work` (admission and the controller).
- **Storage:** DSH storage domain `system_work` (version 1, SQLite), table
  `work`, one key per Work. A record holds the append-only events and the
  state they fold to; every change is one atomic `update(workId, fn)`.
- **Specs:** an admitted Workflow is pinned as an Artifact of kind
  `workflow-spec@1`; the Work records its ID and never reads the file again.

## Pieces

- [src/workflow.ts](src/workflow.ts) — parse (`yaml`, duplicate keys refused),
  zod schema, preflight, resolve, and the direct Task's implicit spec. Pure.
- [src/record.ts](src/record.ts) — event and state schemas and the pure `fold`.
- [src/registry.ts](src/registry.ts) — `Capabilities`: register Workers and
  verifiers, route by capability with a reason for every candidate.
- [src/controller.ts](src/controller.ts) — `WorkController`: admit, run,
  recover, replay. No domain-specific branch.
- [src/control.ts](src/control.ts) — `FileControl`: the per-Work lock and cancel request; `MemoryControl`, the same in memory for a Host.
- [src/host.ts](src/host.ts) — `Host` ([the Host](../../docs/architecture/host.md),
  H2, in process): takes the Host lock, owns the controller, runs every
  Work-changing operation through the commit lane, answers repeated
  `commandId`s from receipts, and recovers on start. `Host.start`,
  `submit`, `run`, `retry`, `cancel`, `decide`, `get`, `list`, `replay`,
  `interrupted`, `uncertain`, `close`.
- [src/host-lock.ts](src/host-lock.ts) — `acquireHostLock`: an abstract Unix
  socket named after the canonical `DSH_HOME` (Linux only).
- [src/lane.ts](src/lane.ts) — `commitLane`: sections run one at a time, in order.
- [src/summary.ts](src/summary.ts) — `summarize`: duration, attempts,
  operator touches and usage from a Work's events (`system work report`):
  total, cache read, cache write and fresh input tokens, with attempts that
  did not split their cache use counted in `unsplitAttempts`, never as zero;
  `costUsdEstimate` totals the CLI's API-equivalent cost estimate (not what the
  subscription is billed) over the attempts that report it, from records'
  `costUsd`, old ones included.
- [src/conversation.ts](src/conversation.ts) — `conversation@1` (PROP-0003):
  a conversation held elsewhere taken in as `file@1` parts under a manifest
  of what the operator asserts and a fixed notice; the preview and its
  secret warnings, over the parts, their names and the asserted fields.
- [src/index.ts](src/index.ts) — the Cordis row and `WorkService` (new task,
  add a conversation, admit a file or a direct Task).

## Cancel, takeover and one host per Work

Each DSH host caches records in memory, so only the host that holds a Work's
lock (`$DSH_HOME/system/control/<work>.lock`, its `<pid> <start time>` token
(the start time from `/proc` where it exists), published by linking a
complete file so it never exists empty; a dead pid's lock is stale, and so is
one whose pid a different process now has; a stale lock is removed only
under the `<work>.takeover` mutex, published the same way, after reading it
again, so a live host's lock is never moved away; a fresh acquire never takes
the mutex, and a mutex left by a dead host for over 10 s is removed once)
writes that Work. A host reads the store once when it starts, so each
controller has a host identity (a random ID and the time just before it opened
the store) and marks every write in `<work>.written` (its ID and the time),
before the table update and after it; a host that takes the lock when another
host's mark is not older than its own load refuses ("changed since this
command started") instead of acting on a stale copy. A host's own marks never
fence it, and a Work with no mark is not fenced. The fence compares wall-clock
times of one machine; a host that loads its copy in the few milliseconds
between a crashed host's first mark and its database commit is not caught.
`retry` and `approve` hold the lock from
their check to the end of the run. `system work cancel` from another process writes a
cancel request the running host polls every 250 ms; the host aborts its
attempt, records `observed` (`cancelled`, with partial output) and `terminal`
(`cancelled`, with the caller). With no live host, the cancel is recorded
directly. `system work retry` appends `reopened` (caller, reason, optional
Worker, the partial output as `previous`) and runs the step again as a new
attempt: the Work keeps one history.

## Under the Host

A `Host` is the one process that owns a home, so it needs neither
`FileControl` nor the write fence; the old CLI path keeps them until the
cutover (H4). Each decision of the controller (taking a Work's lock,
dispatch, observe, cancel, decision, admission) is a section of the Host's
commit lane; an attempt's execute phase runs outside it, and its observe
re-enters it. The Works of a Host are run one `drive` per Work, and Works
may overlap only in their execute phases (parallel steps are H5).

A command with a `commandId` leaves a receipt in the optional `receipts` of
its Work record, in the update of the event it caused; a submitted Work's ID
derives from the `commandId` (UUIDv5-style). On start the Host marks every
unreported attempt `attempt-lost`, reconciles effects without applying, and
runs nothing: unlike `WorkController.run` on its own, which dispatches a lost
attempt again at once, only an explicit `run` or `retry` continues.

## Effects and decisions

An effect step runs only after every required verdict on its exact subject
is `pass`; no decision overrides that (ADR-0004 decision 12). Verifiers are
pinned at admission with their version; another version at run time gives an
`error` verdict. `system work retry --step <effect step>` redoes only the
effect. The controller records `effect-intended` (a stable
`op:<sha256>` for the Work, step and subject) before calling the provider
and `effect-observed` after. On restart, or after `apply` throws, it calls
the provider's read-only `reconcile`: `applied` is recorded, `absent` is
applied again (or, after a throw, fails the Work), `unknown` holds it until a
later run reads a definite outcome and resumes. A
cancel records what reconciliation finds and applies nothing.
`decide(workId, {decision, caller})` refuses agent callers; an approval
reruns the Work, a denial fails it.

## Input kinds

[src/kinds.ts](src/kinds.ts): `task@1` (`instructions`, optional `base`,
optional `context`: Artifacts the Worker reads as data, also listed as the
task's inputs) and
`git-tree@1` (`repository`, `commit`, `tree`, `parent`), registered by this
row. [src/git.ts](src/git.ts) snapshots, checks out, captures and pins commits.

## Crash boundaries

| Crash after | Left behind | On `system work run` |
|---|---|---|
| spec Artifact stored, before the Work record | an unreferenced spec Artifact | nothing: no Work exists |
| `dispatched` persisted, during the attempt | a running step; maybe orphan output Artifacts | `attempt-lost`, then a new attempt with the same inputs |
| `observed` persisted | a completed step | not re-run |

A Worker attempt is not an external effect; external effects are M5 and are
never re-run blindly.

## Measured (M2, fake Workers)

A three-step Software Engineering record is about 3.9 KB of JSON, and the
smoke test bounds it at 16 KB. Run one step at a time; there is no
concurrency, automatic retry or timeout yet.

## Reuse

The cycle check, transitive dependency map and "a step uses only what it
depends on" rule follow System 1's workflow preflight (`tsuuanmi/system`
`f199a27`, `packages/plugins/workflow/src/spec.ts`); nothing else of that
engine is used.
