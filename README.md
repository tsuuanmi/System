# System

**System is a durable work control plane for replaceable AI Workers.**

**Work persists. Workers change. Humans govern.**

System manages work continuity, authorization and verifiable outcomes across
different Worker runtimes. It runs on a **DSH/Cordis host and plugin foundation**:
the active service composition is deliberately small, while optional
capabilities and community plugins can be enabled or disabled by configuration
without deleting their source.

**Current state:** product charter and selected architecture are documented;
the MVP implementation has **not** been built or validated in this repository.

## Read and contribute

- [Product Charter](docs/requirements/purpose.md) — mission, purposes and
  philosophy; authoritative product intent.
- [MVP requirements](docs/requirements/mvp.md) — a shared core proven by
  **Software Engineering** and **Research** workflows.
- [Control-plane architecture](docs/architecture/control-plane.md) —
  DSH-hosted logical ownership, plugin boundaries and active composition.
- [ADR-0001](docs/decisions/ADR-0001-control-plane-on-dsh.md) — accepted
  decision and alternatives.
- [DSH architecture research](docs/research/RES-0003-dsh-control-plane-evaluation.md)
  — upstream sources, risks and experiments.
- [Documentation router](docs/README.md) — current knowledge and authority.
- [Portable documentation governance](docs/governance/documentation-architecture.md)
  and [bootstrap guide](docs/governance/bootstrap.md) — reuse this governance
  in an unrelated repository.
- [Agent instructions](AGENTS.md).

No product installation command is published until an implementation and
verified build exist.
