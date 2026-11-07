# @system/work

The `work` row: durable Work, the Workflow file compiler and the generic Work
Controller ([ADR-0002](../../docs/decisions/ADR-0002-work-primitive-configured-workflows.md),
[ADR-0004](../../docs/decisions/ADR-0004-mvp-0-operating-decisions.md) decision 9,
[architecture](../../docs/architecture/workflow-composition.md)).

- **Injects:** `storageDomain`, `artifacts`. **Provides:** `ctx.capabilities`
  (the Worker and verifier registry) and `ctx.work` (the Host core's storage).
- **Storage:** DSH storage domain `system_work` (version 1, SQLite), table
  `work`, one key per Work. A record holds the append-only events and the
  state they fold to; every change is one atomic `update(workId, fn)`.
- **Specs:** an admitted Workflow is pinned as an Artifact of kind
  `workflow-spec@1`; the Work records its ID and never reads the file again.

## Pieces

- [src/workflow.ts](src/workflow.ts) — parse (`yaml`, duplicate keys refused),
  zod schema, Sub-workflows joined (`uses`, from the files `resolve` is
  given), preflight, resolve, and the direct Task's implicit spec. Pure.
- [src/record.ts](src/record.ts) — event and state schemas and the pure `fold`.
- [src/registry.ts](src/registry.ts) — `Capabilities`: register Workers and
  verifiers, route by capability with a reason for every candidate.
- [src/controller.ts](src/controller.ts) — `WorkController`: admit, run,
  recover, replay, and the scheduler (ready steps). No domain-specific branch.
- [src/slots.ts](src/slots.ts) — `Slots`: the Accounts' slots.
- [src/live.ts](src/live.ts) — `LiveAttempts`: each running Worker attempt's
  start, last activity and the `progress` its Worker reported (in memory
  only, never an event), and the stall notice after `stallMinutes` (the row's
  config, default 10): a `WorkChange` of type `stalled`, once until it reports again.
- [src/control.ts](src/control.ts) — `MemoryControl`: the per-Work lock and cancel request, in memory.
- [src/host.ts](src/host.ts) — `Host` ([the Host](../../docs/architecture/host.md),
  H2, in process): takes the Host lock, owns the controller, runs every
  Work-changing operation through the commit lane, answers repeated
  `commandId`s from receipts, and recovers on start. `Host.start`,
  `submit`, `run`, `retry`, `cancel`, `decide`, `get`, `list`, `replay`,
  `interrupted`, `close`, and `slots` (`uncertain`, `settle`).
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
- [src/goal.ts](src/goal.ts) — Goals (ADR-0009): `GoalStore` over the Artifacts,
  `resolveGoal` (a Goal's newest version and its chain), `spendOf` (the fold of
  attempts and tokens over the Works that name a Goal in the chain) and
  `overBudget`. `WorkController.goalView` and `Host.goal` report a Goal with
  its spend. The store also records decisions (`decide`, `decisions`): each
  `decision@1` names the latest one of its Goal's chain as `previous`, which
  orders them; they are recorded one at a time.
- [src/conversation.ts](src/conversation.ts) — `conversation@1` (PROP-0003):
  a conversation held elsewhere taken in as `file@1` parts under a manifest
  of what the operator asserts and a fixed notice; the preview and its
  secret warnings, over the parts, their names and the asserted fields.
- [src/index.ts](src/index.ts) — the Cordis row and `WorkService` (new task,
  add a conversation, and `startHost`: the `Host` over the row's own table, specs and capabilities).

## Goals

An `Admission` may name a `goal` (the optional `goal` of the `admitted` event;
older records stay valid). Admission reads the Goal's newest version through
the store's `goals`, refuses once `spendOf` its chain reached the budget, and
replaces the input by a `task@1` with the same instructions and the Goal's
`context` first. Nothing about the spend is stored. A running Work is never
stopped by the budget. `WorkService.newGoal` stores a Goal, with the Charter
([docs/requirements/purpose.md](../../docs/requirements/purpose.md)) as a file
Artifact when no `context` is given.

## Cancel and retry

The Host owns every Work, so a Work's lock and its cancel request live in
memory (`MemoryControl`). A cancel of a running Work is a request its run polls
every 250 ms: the run aborts its attempt, records `observed` (`cancelled`, with
partial output) and `terminal` (`cancelled`, with the caller). With no run, the
cancel is recorded directly. `system work retry` appends `reopened` (caller,
reason, optional Worker, the partial output as `previous`) and runs the step
again as a new attempt: the Work keeps one history. On a verify step (`--step
checks.checks`) the verifier is asked again on the same subject and pinned
criteria; `reopened` clears the step's verdict in the state, and the earlier
`verified` event stays. Only a human caller does this: an agent could keep
asking until a run passes. `retry` and `decide` hold
the Work's lock from their check to the end of the run.

## Under the Host

A `Host` is the one process that owns a home, so no file lock or write fence
is needed (the per-Work lock files, takeover mutex and write marks of the old
per-command mode were removed in R1; the Host ignores any left over). Each decision of the controller (taking a Work's lock,
dispatch, observe, cancel, decision, admission) is a section of the Host's
commit lane; an attempt's execute phase runs outside it, and its observe
re-enters it. The Works of a Host are run one `drive` per Work, and Works
and the steps of one Work overlap in their execute phases (below).

A command with a `commandId` leaves a receipt in the optional `receipts` of
its Work record, in the update of the event it caused; a submitted Work's ID
derives from the `commandId` (UUIDv5-style). On start the Host marks every
unreported attempt `attempt-lost`, reconciles effects without applying, and
runs nothing: unlike `WorkController.run` on its own, which dispatches a lost
attempt again at once, only an explicit `run` or `retry` continues.

## Scheduling and slots

A `drive` dispatches every ready step (pending, every `dependsOn` succeeded) whose
Account has a free slot, in Workflow file order, then waits for an attempt to
report or a slot to be freed. An Account is a Worker's `ref`; a `WorkerPort`
offers `maxConcurrentAttempts` (default 1, set per Account in the `agents` row)
and an optional `gone(attemptId)`. A slot is reserved in the lane before
`dispatched` is appended and released after `observed` is. Verifier and effect
steps take none. Steps that find no slot wait in memory; a freed slot wakes the
waiting Works in Work admission order. A cancel, a failed step or an unknown
effect stops new dispatches, and the Work's terminal event follows once the
attempts in flight are recorded.

At Host start each lost Worker attempt keeps its Account's slot (`uncertain()`)
until `settle()` finds its Worker's `gone(attemptId)` true; a Worker without
`gone` is never confirmed. The `run` of its Work waits for the slot.
`WorkController.run` on its own, without a Host, applies the same slots.

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
`git-tree@1` (`repository`, `commit`, `tree`, `parent`) and `goal@1` (`aim`,
`scope`, `budget: { attempts?, tokens? }`, `context`: Artifact IDs) and
`decision@1` (`goal`, `question`, `options`, `choice`, `reason`, `restsOn`,
`by`, optional `previous`), registered by this row. [src/git.ts](src/git.ts) snapshots, checks out, captures and pins commits.

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
smoke test bounds it at 16 KB. There is no automatic retry.

## Reuse

The cycle check, transitive dependency map and "a step uses only what it
depends on" rule follow System 1's workflow preflight (`tsuuanmi/system`
`f199a27`, `packages/plugins/workflow/src/spec.ts`); nothing else of that
engine is used.
