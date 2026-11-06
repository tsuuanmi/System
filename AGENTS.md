# Agent instructions

System is a DSH-hosted **durable work control plane**, not a new agent runtime.
MVP-0 is implemented in [packages](packages/README.md) (see the evidence in the
[MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md); the next iteration is
[PLAN.md](PLAN.md)); [test-support](test-support/README.md) holds the shared
test stand-ins. Changes to this repository are checked by
[`.system/checks.yaml`](.system/checks.yaml).

## Read before changing

1. Read the [Product Charter](docs/requirements/purpose.md) and the
   [MVP contract](docs/requirements/mvp.md).
2. Read the [documentation router](docs/README.md), the
   [local governance profile](docs/governance/documentation.md) and
   [ADR-0001](docs/decisions/ADR-0001-control-plane-on-dsh.md),
   [ADR-0002](docs/decisions/ADR-0002-work-primitive-configured-workflows.md),
   and [ADR-0003](docs/decisions/ADR-0003-artifact-ids-and-verification-contracts.md).
3. Read relevant [control-plane architecture](docs/architecture/control-plane.md),
   draft boundaries, research and proposals. Research is evidence, not a
   production promise.
4. Run `python3 tools/docs.py trace <path-or-ID>` on existing affected
   documents/IDs. When product source is added, read its nearest README,
   implementation and tests.

## Product invariants

- **Work-first:** Task is the primitive; a Workflow is an optional external
  **config file**. Step order/dependencies, Worker capabilities and verifier
  selection live in config, not domain-specific engine code.
- **Artifact-first:** inter-Worker handoff uses immutable **Artifact IDs**,
  not copied conversation transcripts or mutable workspace paths. Controller
  replay is deterministic from pinned specs and recorded observations, not
  repeated LLM inference.
- **Verification as capability:** bind each configured verification verdict
  to an exact Artifact ID, criteria and version; do not force a universal
  code-review or model-review pipeline onto unrelated workflows.
- **Control plane on DSH:** reuse DSH/Cordis for hosting, plugin composition
  and available Worker execution. Do not build a parallel plugin manager or
  general-purpose model loop.
- **Config-first optionality:** optional plugins are disabled/enabled in the
  effective DSH composition, not deleted from the codebase as a first resort.
  Plugin admission must respect dependency, version and security checks.
- **Cross-domain MVP:** one core supports both Software Engineering and
  Research, with domain differences in Worker adapters, task definitions and
  verification policies. No domain-specific controller branch.
- **Authority and effects:** no Worker or community plugin silently expands
  authority. Unknown side effects cannot be blindly retried. Plugin unload
  with in-flight work requires a safe drain/hold/reconciliation path.
- **Evidence over claims:** verification applies to the exact artifact.
  Never assert tested reliability or active plugins from configuration
  documentation alone.
- **Stay changeable** ([Charter](docs/requirements/purpose.md#philosophy)
  11): growth is fine, but losing the ability to change is not.
  - Prefer deleting or simplifying to adding a layer.
  - Record growth of the active core and the docs at each milestone in
    [PLAN.md](PLAN.md), and justify growth beyond its budget.
  - Never let docs restate what code, tests or another doc already say.
- **Fast, testable feedback** (Charter 12):
  - Every behavior change comes with a test that failed first.
  - Keep `.system/checks.yaml` within its time budget.
  - Treat a flaky test as a defect to fix before new features.
- **Standards and determinism** (Charter 8): before inventing a format or
  mechanism, name the existing standard you considered (git, JSON Schema,
  MCP, systemd...). What System records stays deterministic and
  artifact-based.

## Documentation change rules

Use [the portable standard](docs/governance/documentation-architecture.md).
Update authoritative documents in the same change as the behavior they
describe. Keep one home per fact, put typed edges in front matter, do not edit
generated indexes manually, and never treat external audit evidence as
System implementation truth.

## Required verification

Run `python3 tools/docs.py check` and
`python3 tools/docs.py sync --check`. On a PR with covered paths run
`python3 tools/docs.py impact <base-ref>`. When code exists, also run
its source/test/CI checks. Report what was not verified.
