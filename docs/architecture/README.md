# Architecture

This area owns the **selected architectural direction** and its evolving
boundary contracts. Selection is not the same as a working implementation.

- [Control-plane architecture](control-plane.md) — accepted logical ownership,
  DSH/Cordis host composition, plugin lifecycle and cross-workflow invariants.
- [Work and Workflow composition](workflow-composition.md) — Task as primitive,
  declarative config with dependencies and capability-based steps.
- [Artifact IDs and verification](artifact-verification.md) — immutable
  handoff, replay boundaries and configurable verifier capabilities.
- [Brainstorm composition](brainstorm-composition.md) — three Worker attempts and Artifact ID handoff.
- [Work ownership and recovery](work-ownership-and-recovery.md) — the old file mechanisms, removed in R1; recovery invariants.
- [Host](host.md) — milestone H: one long-lived process owning every Work (implemented; see its status).
- [Boundary and failure questions](boundaries.md) — draft interface sketches,
  risks and implementation questions not yet proven in code.

Architectural rationale: [ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md),
[ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md) and
[ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md).
The product's why and scope live in the
[Product Charter](../requirements/purpose.md) and
[MVP requirements](../requirements/mvp.md).
DSH capability references, alternatives and experiments belong in
[research](../research/RES-0003-dsh-control-plane-evaluation.md).
