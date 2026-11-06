---
level: 1
areas: [governance=governance, requirements=requirement, architecture=architecture, decisions=decision, research=research, proposals=proposal]
id-prefixes: [proposal=PROP, research=RES, decision=ADR]
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
- [Requirements](../requirements/README.md) — accepted product purpose,
  philosophy and MVP behavior; no shipped implementation is implied.
- [Architecture](../architecture/README.md) — accepted control-plane/DSH
  direction and separate draft interface mechanics.
- [Decisions](../decisions/README.md) — durable architectural rationale.
- [Research](../research/README.md) — external evidence, risks and proposed
  experiments; non-normative.
- [Proposals](../proposals/README.md) — implementation and design questions
  still awaiting acceptance.

Other standard areas will be added when source, specific design, validation,
engineering or operations knowledge actually exists.

## Local identity and graph policy

Typed IDs: `PROP-NNNN` for proposals, `RES-NNNN` for research and
`ADR-NNNN` for decisions. Never reuse IDs. The local `source-roots` list
stays empty until System contains source packages. When introduced, add
their ownership READMEs and relevant `covers` edges. Use wikilinks for typed
document references and normal Markdown links in routers and for source files.

## Available commands

From the root, using Python 3.11+ and no third-party packages:

| Command | Purpose |
|---|---|
| `python3 tools/docs.py check` | Structure, identity, local paths and supported graph checks |
| `python3 tools/docs.py sync` | Generate supported index blocks |
| `python3 tools/docs.py sync --check` | Verify indexes have no drift |
| `python3 tools/docs.py trace <path-or-ID>` | Trace declared document edges and inverses |
| `python3 tools/docs.py impact <base-ref>` | Check changed, covered paths and explicit PR waivers |
| `python3 tools/bootstrap_docs.py --out <target> --name <name>` | Create a different project's governance skeleton without overwriting files |

CI runs check, sync --check and impact (PR only), plus a bootstrap smoke test.
A waiver is a PR-body line like
`docs-unchanged: docs/architecture/control-plane.md — formatting-only change`.

**Conformance disclosure:** this is a **Level 1** bootstrap checker with
additional limited graph support; not every Level 2/3 check, complete impact
closure, or automated retirement is implemented.

## Change and retirement

One fact, one home. Update the authoritative document with its behavior.
Research and proposals never silently become requirements. Accepted knowledge
is promoted before obsolete documents are retired. For retirement, fold
surviving facts forward, rewrite links, append an [ledger](retired.md) entry
with last live commit/path, and never reuse the ID.
