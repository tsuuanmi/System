---
type: architecture
status: active
reviewed: 2026-11-05
decided-by: [ADR-0002]
covers: [packages/work/src/workflow.ts, packages/work/src/record.ts, workflows/*.yaml]
---

# Work primitive and declarative Workflow composition

**Accepted architecture; `system.workflow/v1` is implemented** by
[`@system/work`](../../packages/work/README.md) and exercised with fake Workers
(M2); real Workers and verifiers arrive in M3 and M4. Work/Task
is the basic durable unit. A Workflow is a versioned **config file** interpreted
by a single generic Work Controller; it is not a code module per use case.
The decision is [ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md).

## Ownership and lifecycle

| Concept | Responsibility |
|---|---|
| Work/Task | durable identity, objective, outcome, current status, artifact refs |
| Attempt | one Worker execution against frozen input references |
| Workflow definition | ordered/dependent steps, capability requirements, artifact mappings, verification policies; external data |
| Admitted workflow snapshot | canonical resolved config and its hash/Artifact ID used by one run |
| Worker adapter | obtains authorized artifact inputs, executes a step, returns Artifact IDs and observations |
| Verifier capability | checks an exact artifact against versioned criteria and records verdict |
| DSH composition | decides which plugins/services/Worker adapters are actually enabled |

**Normal single Task:** one direct admission -> execute -> produce artifact ->
verify if required -> terminal outcome. It does **not** need a user-authored
workflow YAML or a multi-node DAG.

**Configured Workflow:** one Work may encompass dependent steps. Runtime
creates subordinate attempts or internal step records, but preserves a
single accepted config version for that run. The config is read from an
external file, validated, canonicalized and recorded at admission.

## Minimal authoring vocabulary

The MVP workflow file SHOULD express only:

- `id`, `version` and optionally an input artifact schema;
- `steps` with stable step IDs and `dependsOn` to order/depend on work;
- required Worker `capabilities` and policy-constrained parameters;
- named output artifact slots and references to prior slots;
- optional per-step or final `verify` contract/capability and acceptance gate;
- bounded time, retry and concurrency policies where necessary.

Unknown fields, broken dependencies, cycles, missing output slots, unsupported
capabilities, invalid verifier IDs and incompatible schema versions are
rejected *before starting a Worker*. Configured Worker IDs may be hints, but
default selection is capability-based, not hardcoded to a vendor.

## The implemented vocabulary: `system.workflow/v1`

Top level: `schema: system.workflow/v1`, `id`, a positive integer `version`,
and 1 to 32 `steps`. Each step has an `id`, optional `dependsOn`, and exactly
one form:

| Form | Fields | Meaning |
|---|---|---|
| Worker step | `capabilities`, `outputs`, optional `inputs` (`name: $work.input` or `$steps.<step>.<slot>`) | one Worker attempt; each output slot must name a stored Artifact |
| verify step | `verify: {capability, subject, criteria}` | one verifier call on the exact Artifact the `subject` reference resolves to |
| accept step | `accept: {requires: [verify steps], approval?: operator}` | the terminal decision; at most one, and last |

Preflight refuses, before any Worker runs: unknown fields, YAML duplicate keys,
another schema version, duplicate steps, unknown or self dependencies, cycles
(with their path), a reference to a step the step does not depend on or to an
output that step does not declare, an accept step on a non-verify step, more
than one accept step, and any Worker or verifier capability the **effective**
composition does not provide.

The repository's two files are [`workflows/software-engineering.yaml`](../../workflows/software-engineering.yaml)
and [`workflows/research.yaml`](../../workflows/research.yaml). They differ
only in capabilities, output slots and verifier. Compared with the earlier
sketch, `inputs` binds Artifacts explicitly, `version` is required, and
`approval: operator` replaces `operator-merge`, because System never merges
(ADR-0004 decision 10).

The resolved spec is the validated workflow with its steps in a stable
dependency order (file order among ready steps) and each `dependsOn` sorted
and deduplicated, so how dependencies are written never changes the spec. It
is pinned as an Artifact of kind `workflow-spec@1`; its Artifact ID is the
spec hash. A direct Task without a file is the same spec with one implicit
step `task`, output `result`.

**Outcomes:** every step done and every required verdict `pass` is
`succeeded`; any `fail` or `error` verdict, a failed step, or a Worker missing
at run time is `failed`; an `inconclusive` verdict or `approval: operator` is
`held` for the operator. Missing evidence is never a pass, with or without an
accept step.

## Deterministic admission and replay boundary

1. Validate and resolve the config against the **effective DSH plugin
   composition**, schemas and policy at admission.
2. Persist a content-addressed, canonical **resolved workflow spec** and
   record its Artifact ID on the Work before dispatch.
3. Assign Worker and resolve step aliases against a snapshot of actual
   Artifact IDs; persist the choice and reason before its effects.
4. Record completed result IDs, verifier evidence, approval/denial and
   external observations. Replay uses the recorded history, **not**
   a rerun of Worker/model reasoning.
5. Editing the YAML does not mutate a running Work's spec. Removal disables
   **new admissions** but does not discard persisted in-flight specs.
6. Only an explicit migration/decision can rebind a live Work to a new
   spec/version. That must invalidate any affected downstream verification.
7. Where the remote side effect is uncertain, hold or reconcile it before
   retrying. Workflow structure alone cannot guarantee exactly-once effects.

**Implemented recovery:** each Work is one storage key holding its events
(`admitted`, `dispatched`, `observed`, `verified`, `attempt-lost`, `terminal`)
and the state they fold to; every change is one atomic update. A step whose
last attempt was dispatched but never observed is recorded `attempt-lost` and
dispatched again as a new attempt with the same recorded inputs; completed
steps are never re-run. `system work replay` folds the events again and
compares the result with the stored state.

DAG support should emerge from `dependsOn` only. Do not require a
DAG-specific user abstraction for a one-step task.

## Config is not capability installation

DSH profile/bundle config controls plugin activation. System Workflow YAML
only requests already available capabilities. It cannot silently enable an
untrusted Worker, install a package, grant new egress or approve an effect.
An optional plugin disabled via DSH config makes dependent workflow
admission fail with a clear missing-capability reason.

See [Artifact-ID handoff](artifact-verification.md),
[MVP requirements](../requirements/mvp.md), and the
[source audit](../research/RES-0004-reference-workflow-artifact-audit.md).
