---
level: 1
areas: [governance=governance, architecture=architecture, research=research, proposals=proposal]
id-prefixes: [proposal=PROP, research=RES]
source-roots: []
forbidden-names: [archive, archives, deprecated, history, legacy, old, temp, temporary]
ledger: governance/retired.md
reachability-depth: 3
review-days: 365
max-lines: 500
reviewed: 2026-11-05
---

# System documentation profile

System adopts its own [Portable Documentation Architecture Standard](documentation-architecture.md).
That is the product-agnostic specification for future repositories. **This
file is only the local System configuration**; do not copy its areas or product
assumptions into another project. For reuse, see [bootstrap](bootstrap.md).

## Active areas and authority

- [Governance](README.md) — documentation standard, tooling and lifecycle.
- [Architecture](../architecture/README.md) — early **draft** logical boundaries,
  not a deployed implementation or a frozen runtime choice.
- [Research](../research/README.md) — audit sources, constraints, evidence and
  alternatives, without production authority.
- [Proposals](../proposals/README.md) — pending product direction and scope.

Other standard areas will be added as actual decisions, requirements, code
contracts, validations or procedures exist. The absence of a folder is not a
claim that the responsibility is unimportant.

## Local identity and graph policy

Typed IDs: `PROP-NNNN` for proposals and `RES-NNNN` for research.
Never reuse IDs. The local `source-roots` list stays empty until System
contains source packages. When introduced, add their README ownership and
relevant `covers` edges. Use wikilinks for typed document references and
normal Markdown links in routers and for source files.

## Available commands

From the root, using Python 3.11+ and no third-party packages:

| Command | Purpose |
|---|---|
| `python3 tools/docs.py check` | Structure, identity, local paths and supported graph checks |
| `python3 tools/docs.py sync` | Generate supported index blocks |
| `python3 tools/docs.py sync --check` | Verify indexes have no drift |
| `python3 tools/docs.py trace <path-or-ID>` | Trace declared document edges and inverses |
| `python3 tools/docs.py impact <base-ref>` | Check changed, covered paths and explicit PR waivers |
| `python3 tools/bootstrap_docs.py --out <target> --name <name>` | Create a new project's documentation skeleton without overwriting files |

CI runs check, sync --check and impact (PR only), plus a bootstrap smoke test.
A waiver is a PR-body line like
`docs-unchanged: docs/architecture/boundaries.md — formatting-only change`.

**Conformance disclosure:** this is a **Level 1** bootstrap checker with some
additional graph features; it does **not** implement every Level 2/3 rule,
complete impact closure, or automated retirement. Do not raise the profile
level until implementation and CI prove the additional contract.

## Change and retirement

One fact, one home. Update the authoritative document with its behavior.
Research and proposals never silently become requirements. Accepted knowledge
is promoted before obsolete documents are retired. For retirement, fold
surviving facts forward, rewrite links, append an [ledger](retired.md) entry
with last live commit/path, and never reuse the ID.
