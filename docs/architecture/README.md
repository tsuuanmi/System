# Architecture

This area owns the **selected architectural direction** and its evolving
boundary contracts. Selection is not the same as a working implementation.

- [Control-plane architecture](control-plane.md) — accepted logical ownership,
  DSH/Cordis host composition, plugin lifecycle and cross-workflow invariants.
- [Boundary and failure questions](boundaries.md) — draft interface sketches,
  risks and implementation questions not yet proven in code.

The architectural rationale is [ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md).
The product's why and scope live in the
[Product Charter](../requirements/purpose.md) and
[MVP requirements](../requirements/mvp.md).
DSH capability references, alternatives and experiments belong in
[research](../research/RES-0003-dsh-control-plane-evaluation.md).
