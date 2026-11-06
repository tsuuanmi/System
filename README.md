# System

**System is a durable work control plane for replaceable AI Workers.**

**Work persists. Workers change. Humans govern.**

System manages work continuity, authorization and verifiable outcomes across
different Worker runtimes. It runs on a **DSH/Cordis host and plugin foundation**:
the active service composition is deliberately small, while optional
capabilities and community plugins can be enabled or disabled by configuration
without deleting their source.

**Current branches:** this documentation branch contains no executable product
code. A **working MVP-0 implementation is documented and tested** on the
stacked [draft PR #2](https://github.com/tsuuanmi/System/pull/2) (not merged).

## Read and contribute

- [Product Charter](docs/requirements/purpose.md) — mission, purposes and
  philosophy; authoritative product intent.
- [MVP requirements](docs/requirements/mvp.md) — a shared core proven by
  **Software Engineering** and **Research** workflows.
- [Control-plane architecture](docs/architecture/control-plane.md) —
  DSH-hosted logical ownership, plugin boundaries and active composition.
- [Declarative Workflow composition](docs/architecture/workflow-composition.md)
  — Work/Task primitive; step graphs, Workers and verification in config files.
- [Artifact-ID and verification contracts](docs/architecture/artifact-verification.md)
  — deterministic handoff, exact-subject evidence and verifiers as capabilities.
- [ADR-0001](docs/decisions/ADR-0001-control-plane-on-dsh.md) — accepted
  decision and alternatives.
- [DSH architecture research](docs/research/RES-0003-dsh-control-plane-evaluation.md)
  — upstream sources, risks and experiments.
- [Current MVP-0 plugin audit](docs/research/RES-0005-plugin-reuse-audit.md)
  — source-backed reuse/adapt/keep/defer assessment against PR #2 and pinned DSH.
- [Brainstorm architecture](docs/architecture/brainstorm-composition.md) — three attempts, Artifact handoff and no new Team engine.
- [Work ownership and recovery](docs/architecture/work-ownership-and-recovery.md) — B4 regression and fixes.
- [PR #2 source review](docs/research/RES-0007-brainstorm-and-concurrency-review.md) — B3 results pending human scores.
- [Brainstorm feasibility and System 1 reference](docs/research/RES-0006-brainstorm-workflow-feasibility.md)
  — three Worker attempts on the existing Claude/Codex runtimes.
- [Draft post-MVP roadmap](docs/proposals/PROP-0002-post-mvp-roadmap.md)
  — Brainstorm first; Research quality verification and Website Worker later.
- [Next implementation plan](PLAN.md) — local-agent checklist and test gates;
  implementation belongs on PR #2 or a separately chosen code branch.
- [Documentation router](docs/README.md) — current knowledge and authority.
- [Portable documentation governance](docs/governance/documentation-architecture.md)
  and [bootstrap guide](docs/governance/bootstrap.md) — reuse this governance
  in an unrelated repository.
- [Agent instructions](AGENTS.md).

This documentation-only branch does not publish a product installation command.
The working setup and test commands are in [draft PR #2](https://github.com/tsuuanmi/System/pull/2).
