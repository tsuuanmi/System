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
- [src/index.ts](src/index.ts) — the Cordis row and `WorkService` (admit a
  file or a direct Task).

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
concurrency, retry policy or timeout yet.

## Reuse

The cycle check, transitive dependency map and "a step uses only what it
depends on" rule follow System 1's workflow preflight (`tsuuanmi/system`
`f199a27`, `packages/plugins/workflow/src/spec.ts`); nothing else of that
engine is used.
