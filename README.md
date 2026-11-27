# System

**System is the gate and the ledger for the work one operator delegates to AI Workers.**

**Work persists. Workers change. Humans govern.**

System manages work continuity, authorization and verifiable outcomes across
different Worker runtimes. It runs on a **DSH/Cordis host and plugin foundation**:
the active service composition is deliberately small, while optional
capabilities and community plugins can be enabled or disabled by configuration
without deleting their source.

**Current state:** the MVP-0 milestones and the iterations after them (Brainstorm
among them) are finished and recorded in [PLAN.md](PLAN.md) section 1; open work
is the Items of [STATUS.md](STATUS.md), and [GLOSSARY.md](GLOSSARY.md) is the
vocabulary. System runs on the `system` DSH profile: `system work` admits
Workflow files or direct Tasks and runs them durably, with Claude Code and Codex
accounts as Workers, verifies results with the repository's pinned checks or
citation checks, and publishes a checked commit as one pull request (a draft, or
merged when its base is on the `mergeInto` allowlist, `dev`; `main` stays the
operator's, ADR-0008). `system approve` is for a human at a terminal. The
original MVP-0 plan is kept at
[its pinned commit](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md) as history.

## Read and contribute

- [Product Charter](docs/requirements/purpose.md) — mission, purposes,
  philosophy and the MVP scope; authoritative product intent.
- [Control-plane architecture](docs/architecture/control-plane.md) —
  DSH-hosted logical ownership, plugin boundaries and active composition.
- [Declarative Workflow composition](docs/architecture/workflow-composition.md)
  — Work/Task primitive; step graphs, Workers and verification in config files.
- [Artifact-ID and verification contracts](docs/architecture/artifact-verification.md)
  — deterministic handoff, exact-subject evidence and verifiers as capabilities.
- [Decisions](docs/decisions/README.md) — the accepted ADRs and their alternatives.
- [DSH evidence](docs/decisions/ADR-0001-control-plane-on-dsh.md#evidence-and-follow-up)
  — upstream sources behind the host choice (RES-0003, retired).
- [Brainstorm architecture](docs/architecture/brainstorm-composition.md) — three attempts, Artifact handoff, no new Team engine, and the shape of the three-attempt Workflow.
- [Host](docs/architecture/host.md#crash-and-recovery-invariants) — one long-lived process owning every Work; its crash and recovery invariants.
- [PLAN.md](PLAN.md) — finished milestones, standing decisions and open work; [STATUS.md](STATUS.md) lists the Items.
- [GLOSSARY.md](GLOSSARY.md) — the vocabulary.
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
and [tests](tests/README.md). Releases and `system update`:
[releases](docs/operations/releases.md).

## Operating System

The operator pages are [runbook](docs/operations/runbook.md) (the index),
[install and update](docs/operations/install-and-update.md) and
[using System](docs/operations/using-system.md); the commands are in the
[app README](packages/app/README.md). A first use, after `bin/system credentials set`
for each Worker (see the runbook):

```sh
TASK=$(bin/system task new --repo <path> --text "<what to do>")   # the repository's base commit needs .system/checks.yaml and an `origin` remote
bin/system work submit --workflow workflows/develop.yaml --input "$TASK"
bin/system work show <work>          # events, verdicts, the published branch and pull request
```

`workflows/develop.yaml` is the default for a change to a repository; the
others are in [workflows](workflows/).

**System develops System:** [`.system/checks.yaml`](.system/checks.yaml) is
this repository's own required checks.
