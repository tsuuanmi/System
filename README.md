# System

**System is a durable work control plane for replaceable AI Workers.**

**Work persists. Workers change. Humans govern.**

System manages work continuity, authorization and verifiable outcomes across
different Worker runtimes. It runs on a **DSH/Cordis host and plugin foundation**:
the active service composition is deliberately small, while optional
capabilities and community plugins can be enabled or disabled by configuration
without deleting their source.

**Current state:** MVP-0 is implemented (its milestones and evidence are in
the [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md)); the next iteration,
Brainstorm, is planned in [PLAN.md](PLAN.md). The `system` DSH profile boots,
`system doctor` checks it, `system artifact` stores and reads immutable
Artifacts by ID, and `system work` admits Workflow files or direct Tasks and
runs them durably, with Claude Code and Codex accounts as Workers (cancel and
takeover included), verifies results with the repository's pinned checks or
citation checks, and publishes a checked commit as one pull request (a draft, or merged when its
base is on the `mergeInto` allowlist, `dev`; `main` stays the operator's,
ADR-0008); `system approve` is for a human at a terminal.

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
- [Work ownership and recovery](docs/architecture/work-ownership-and-recovery.md) — the old file mechanisms, removed in R1; where the Host holds each guarantee.
- [PR #2 source review](docs/research/RES-0007-brainstorm-and-concurrency-review.md) — Brainstorm, concurrency hypotheses and the next evaluation.
- [Brainstorm evaluation](docs/research/RES-0008-brainstorm-evaluation.md) — B3: five briefs, three arms, blind scores by a model judge.
- [Brainstorm feasibility and System 1 reference](docs/research/RES-0006-brainstorm-workflow-feasibility.md)
  — three Worker attempts on the existing Claude/Codex runtimes.
- [Draft post-MVP roadmap](docs/proposals/PROP-0002-post-mvp-roadmap.md)
  — Brainstorm first; Research quality verification and Website Worker later.
- [Next implementation plan](PLAN.md) — local-agent checklist and test gates.
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

## Operating MVP-0

Credentials go into the DSH store by name; values are never printed:

```sh
bin/system credentials set CLAUDE_CODE_OAUTH_TOKEN   # from `claude setup-token`
mkdir -p ~/.dsh/system/codex/default
CODEX_HOME=~/.dsh/system/codex/default codex login --device-auth
bin/system credentials set GITHUB_TOKEN              # System's own; Workers never get it
bin/system workers                                   # which accounts are usable, and why not
bin/system workers login web/chatgpt/default --cookies cookies.json   # an account that is not in the bundle; see the runbook
```

A Software Engineering change needs a repository whose base commit has
[`.system/checks.yaml`](.system/checks.yaml) and an `origin` remote:

```sh
TASK=$(bin/system task new --repo <path> --text "<what to do>" | tail -1)
bin/system work submit --workflow workflows/software-engineering.yaml --input "$TASK"
bin/system work show <work>          # events, verdicts, the published branch and pull request
bin/system approve <work>            # held Work: a human at a terminal only
bin/system work cancel <work> --wait
bin/system work retry <work> [--step implement] [--worker codex/default]
bin/system work submit ... --worker codex/default   # only that Worker takes its Worker steps
```

Research takes a question as its input
(`bin/system task new --text "<question>"`, then `--workflow workflows/research.yaml`).
Brainstorm takes a brief the same way (`--workflow workflows/brainstorm.yaml`):
Claude Code and Codex each write a proposal, then a synthesis compares them;
`bin/system work show <work>` lists the three output Artifact IDs and
`bin/system artifact cat <id>` prints one.
A conversation held elsewhere (such as in a web chat) becomes Artifacts and
then a task's context:

```sh
bin/system conversation add --response chat.md [--prompt asked.md] [--attach export.json] \
  [--provider ChatGPT] [--url <url>] [--selection complete|excerpts|summary] \
  [--product-context browsing]                         # preview only
bin/system conversation add ... --yes                # store; prints the conversation ID
bin/system conversation add ... --yes --accept-warnings   # store although the preview warns
bin/system conversation show <id>
bin/system task new --text "<what to do>" --context <id>
```

The preview warns when the files, their names or the stated fields (a URL
with a token in it) look like a credential; `--yes` then refuses unless
`--accept-warnings` is given. System stores the bytes as given and labels them operator-supplied and
unverified ([PROP-0003](docs/proposals/PROP-0003-conversation-ingestion.md)).
A step asks for a model tier with the capability `tier.economy`,
`tier.standard` or `tier.frontier`.

Environment variables: `DSH_HOME` (default `~/.dsh`), `SYSTEM_OPERATOR_ID`
(default: the OS user), `SYSTEM_CALLER` (`human` or `agent`; labels a call,
never authorises an approval), `SYSTEM_REAL_AGENTS=1` (runs the
credential-gated tests in `tests/real-agents.test.ts`; `SYSTEM_REAL_WEB=1`
those in `tests/real-web.test.ts`). Launcher flags go
before the command, such as `bin/system --patch overlay.yml work submit ...`.

**System develops System:** [`.system/checks.yaml`](.system/checks.yaml) is
this repository's own required checks. Commit `e99996b` was made by System
through its Software Engineering Workflow (Work `work:6bd9748e…`; Claude Code
at the economy tier; checks passed; published as a draft pull request to a
local mirror) and taken in after review. See the [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md) for the
evidence of every milestone and the known limits.
