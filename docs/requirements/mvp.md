---
type: requirement
status: active
reviewed: 2026-11-05
---

# MVP scope and acceptance contract

The MVP is the **smallest running DSH-hosted System control plane** that proves
[P1–P3](purpose.md#fundamental-purposes). This defines the required outcomes,
not a committed implementation schedule, package inventory or release date.
There is currently no implementation or passing validation in this repository.

## Required common path

```text
client -> work admission -> policy/capability check -> Worker execution
       -> immutable artifact/result -> verification -> accept/hold/reject
                 -> durable state, effect record and inspection
```

**MVP-01 Work continuity:** a stable **Work/Task ID** is the primitive; it
survives interruption independently of model conversation/session or workflow
configuration. A single Task does not require a public multi-step DAG.

**MVP-02 Worker interchangeability:** a bounded Worker contract represents
capabilities, input artifact references, completion/failure, cancellation and
usage; demonstrate a replacement Worker/adapter for at least one comparable
unit of work without changing the controller's code.

**MVP-03 Effect integrity:** actions with external consequences have stable
operation identities and persisted outcomes. On an unknown outcome, the
controller reconciles or holds for authorization rather than blind replay.
Do not claim exactly-once external effects without proof.

**MVP-04 Policy and authority:** Worker calls cannot grant their own wider
authority; entry and effect boundaries enforce declared permissions, data
egress limits and explicit operator approvals.

**MVP-05 Verification:** each configured verifier is a typed capability
contract. It checks an **exact Artifact ID** against pinned criteria and
records an evidence-backed verdict. A changed subject invalidates old
verification; no generic review stage is forced on every workflow.

**MVP-06 Observable accounting:** record events and provider usage with
provenance sufficient to identify resumed-session double counting and explain
operator interventions. Compare accounting with a reliable oracle when one
is available; otherwise mark it unverified.

**MVP-07 Composable execution:** runtime and optional features are assembled
through a **small DSH/Cordis profile/bundle**, with explicit dependencies and
configuration-based enable/disable. Keep optional code installed when
disabled; do not make optional features hidden prerequisites.

**MVP-08 Two domain proofs:** the same Work state machine, policy/effect
semantics and Worker contract run both Software Engineering and Research.
Their step order, capabilities and verification choices come from **two
external configuration files**, not separate domain engines or hardcoded
workflow registration.

**MVP-09 Config-defined composition:** a versioned Workflow configuration
file (prefer YAML) declares ordered/dependent steps, Worker capabilities,
Artifact-ID bindings and verifier capabilities. The admitted resolved spec
is immutable, content-addressed and retained with Work. A config edit or
removal cannot mutate an existing Work; invalid definitions fail preflight.
DSH profile config separately controls enabled plugin capabilities.

**MVP-10 Artifact-ID protocol and orchestration determinism:** durable
inter-Worker handoffs use typed, immutable **Artifact IDs**, not transcripts
or mutable paths. Equal canonical content has stable identity while producer
events and read authority stay distinct. Replay is deterministic from pinned
specs, persisted events and observed decisions; a model's text output need
not be deterministic.

**MVP-11 Verifier interchangeability:** Workflow config chooses one or more
registered verifier capabilities, each bound to the exact Artifact ID and
criteria version and returning a typed evidence-backed verdict. A code-tree
checker and a research citation/evidence checker must both work without a
core change. Model review is optional unless the selected policy requires it.

## Mandatory end-to-end acceptance cases

| Workflow | Scenario | Accepted evidence |
|---|---|---|
| Software Engineering | Input task -> authorized coding Worker -> immutable patch/commit -> required checks -> review/approval -> accepted result | exact checked tree identity, check results, effect and approval provenance |
| Research | Question -> authorized research Worker -> report artifact and source references -> evidence/citation verification -> accepted result | report identity, accessible cited evidence, verification verdict and provenance |

Both workflows MUST load from independent **declarative config files** and
exercise the **same** Work identity, routing/admission, policy enforcement,
Artifact-ID handoff, verification and terminal outcome recording. Modifying
a workflow file must not require rebuilding the Work Controller. Research
must not be a coding workflow renamed. The research verifier checks citation
traceability and bounded claims, not an impossible guarantee of factual truth.

## Failure and governance tests

The admission tests reject duplicate step IDs, cycles, missing artifact
outputs, unavailable Worker/verifier capabilities, bad schemas and policy
violations. One Task must run without an external workflow definition. A
workflow config change mid-run must not change its recorded resolved spec.
A re-executed model may produce different content and a distinct Artifact ID.

1. Restart/crash at assignment, before commit of an external effect and after
   the effect but before recording confirmation. Prove no blind duplicate.
2. Cancel while a Worker is running; persist and explain final disposition.
3. Disable an optional DSH plugin without deleting its package, then run the
   dependency-light profile. Prove the disabled capability is unavailable
   without breaking required services.
4. Attempt to disable a plugin with in-flight work; new work must stop
   entering it, and existing work must drain, transfer or be safely reconciled.
5. Deny a privileged effect and forbidden data egress, including through an
   optional Worker adapter.
6. Replace a Worker and preserve usable work artifacts and criteria.
7. Run Software Engineering and Research with the same controller code;
   confirm there is no domain-specific engine branch.
8. Record timing, restart survival, operator touches and usage provenance.

## Out of MVP unless evidence shows necessity

Multi-user tenancy, hosted service, an extensive UI/board, custom model loop,
general workflow DSL, fleet scheduler, marketplace frontend, agent voting,
complex feedback/learning pipelines and automatic browser automation.

DSH's plugin ecosystem **remains available**. Not being required for the MVP
means a plugin is absent from the *active profile* (or disabled in config), not
that its source must be deleted.

## Measurement policy

Reference R1–R5 targets and historical numbers are research inputs rather than
automatic release gates. Before accepting numeric thresholds, define
denominators and sample windows, track "completed safely" separately from
"terminated after a crash," and measure operator decisions per accepted
task alongside per-day totals. Measure cold start, steady memory, dependency
closure and plugin toggle/reload safety.

## Open implementation choices

The concrete DB, artifact hashing/envelope, Workflow config schema, Worker
transport, DSH bundle layout, process boundaries, CLI/MCP exposure and verifier
implementations require test-backed design.
They may not weaken the requirements above.

See [Workflow composition](../architecture/workflow-composition.md),
[Artifact-ID verification](../architecture/artifact-verification.md),
[control-plane architecture](../architecture/control-plane.md) and the
[pinned source audit](../research/RES-0004-reference-workflow-artifact-audit.md).
