---
type: architecture
status: active
reviewed: 2026-11-05
decided-by: [ADR-0002]
---

# Work primitive and declarative Workflow composition

**Accepted architecture; concrete YAML v1 is implemented on draft PR #2.**
The [workflow compiler](https://github.com/tsuuanmi/System/blob/973cea6c9e00359519569e3b43a7f809215e518f/packages/work/src/workflow.ts)
and [executable configs](https://github.com/tsuuanmi/System/tree/973cea6c9e00359519569e3b43a7f809215e518f/workflows)
are the authority for exact v1 syntax. The examples below are
conceptual sketches, **not runnable v1 examples**. The [Brainstorm
composition](brainstorm-composition.md) adds a third domain without a
new controller, and currently executes ready steps sequentially. Work/Task
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

## Illustrative config: Software Engineering

This is a **sketch, not a validated schema or executable configuration**.
Names and syntax remain open until the loader spike.

```yaml
schema: system.workflow/v1
id: software-engineering
steps:
  - id: implement
    capabilities: [code-write]
    inputs: {task: "$work.input"}
    outputs: [change]
  - id: verify
    dependsOn: [implement]
    verify:
      capability: code.required-checks
      subject: "$steps.implement.change"
      criteria: code-default-v1
  - id: accept
    dependsOn: [verify]
    accept: {requires: [verify], approval: operator-merge}
```

The compiler resolves the symbolic `$steps.implement.change` into an
**exact Artifact ID** before verification or a downstream Worker reads it.
A new patch or commit means a new subject that must be reverified.

## Illustrative config: Research

The schema is **identical**; only the selected Worker and verifier
capabilities differ:

```yaml
schema: system.workflow/v1
id: research
steps:
  - id: investigate
    capabilities: [research, web-search]
    inputs: {question: "$work.input"}
    outputs: [report]
  - id: verify
    dependsOn: [investigate]
    verify:
      capability: research.citation-check
      subject: "$steps.investigate.report"
      criteria: citations-v1
  - id: accept
    dependsOn: [verify]
    accept: {requires: [verify]}
```

Research may also request independent review in config; none is mandated
universally. If the same controller cannot run these two definitions by
changing only config, Worker adapters and verification capabilities,
workflow agnosticism has **failed**.

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
