# System

**System is a durable work control plane for replaceable AI Workers.**

**Work persists. Workers change. Humans govern.**

System manages work continuity, authorization and verifiable outcomes across
different Worker runtimes. It runs on a **DSH/Cordis host and plugin foundation**:
the active service composition is deliberately small, while optional
capabilities and community plugins can be enabled or disabled by configuration
without deleting their source.

**Current state:** MVP-0 is being built milestone by milestone
([PLAN.md](PLAN.md)). M0 to M2 exist: the `system` DSH profile boots,
`system doctor` checks it, `system artifact` stores and reads immutable
Artifacts by ID, and `system work` admits Workflow files or direct Tasks and
runs them durably, with Claude Code and Codex accounts as Workers (cancel and
takeover included), verifies results with the repository's pinned checks or
citation checks, and publishes a checked commit as one draft pull request
(never merging); `system approve` is for a human at a terminal.

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
- [Documentation router](docs/README.md) — current knowledge and authority.
- [Portable documentation governance](docs/governance/documentation-architecture.md)
  and [bootstrap guide](docs/governance/bootstrap.md) — reuse this governance
  in an unrelated repository.
- [Agent instructions](AGENTS.md).

## Build and run (development)

Needs Node `>=24.9.0` (DSH `0.2.2-rc.1` requires it) and corepack.

```sh
corepack pnpm install
corepack pnpm build
bin/system init      # create the `system` profile under $DSH_HOME (default ~/.dsh)
bin/system doctor    # check the mounted rows and durable storage
corepack pnpm check  # build, typecheck, unit tests, offline smoke tests
```

The source is described in [packages](packages/README.md), [bin](bin/README.md)
and [tests](tests/README.md). No release is published.
