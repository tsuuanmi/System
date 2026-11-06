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
- [src/control.ts](src/control.ts) — `FileControl`: the per-Work lock and cancel request.
- [src/summary.ts](src/summary.ts) — `summarize`: duration, attempts,
  operator touches and usage from a Work's events (`system work report`).
- [src/index.ts](src/index.ts) — the Cordis row and `WorkService` (new task,
  admit a file or a direct Task).

## Cancel, takeover and one host per Work

Each DSH host caches records in memory, so only the host that holds a Work's
lock (`$DSH_HOME/system/control/<work>.lock`, its pid, published by linking a
complete file so it never exists empty; a dead pid's lock is stale, and is
taken over by an atomic rename that puts back a live one)
writes that Work. A host reads the store once when it starts, so the lock
holder also notes how many events the Work has (`<work>.written`); a host
that takes the lock with an older copy refuses ("changed since this command
started") instead of acting on it. `retry` and `approve` hold the lock from
their check to the end of the run. `system work cancel` from another process writes a
cancel request the running host polls every 250 ms; the host aborts its
attempt, records `observed` (`cancelled`, with partial output) and `terminal`
(`cancelled`, with the caller). With no live host, the cancel is recorded
directly. `system work retry` appends `reopened` (caller, reason, optional
Worker, the partial output as `previous`) and runs the step again as a new
attempt: the Work keeps one history.

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

[src/kinds.ts](src/kinds.ts): `task@1` (`instructions`, optional `base`) and
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
