# Agent instructions

System is a DSH-hosted **durable work control plane**, not a new agent runtime.
The source tree is currently a documentation and MVP-specification baseline.

## Read before changing

1. Read the [Product Charter](docs/requirements/purpose.md) and the
   [MVP contract](docs/requirements/mvp.md).
2. Read the [documentation router](docs/README.md), the
   [local governance profile](docs/governance/documentation.md) and
   [ADR-0001](docs/decisions/ADR-0001-control-plane-on-dsh.md).
3. Read relevant [control-plane architecture](docs/architecture/control-plane.md),
   draft boundaries, research and proposals. Research is evidence, not a
   production promise.
4. Run `python3 tools/docs.py trace <path-or-ID>` on existing affected
   documents/IDs. When product source is added, read its nearest README,
   implementation and tests.

## Product invariants

- **Work-first:** canonical work identity, handoff artifacts and decisions
  are not owned by a single Worker conversation/session.
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
