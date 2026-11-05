---
level: 1
areas: [governance=governance, proposals=proposal, research=research]
id-prefixes: [proposal=PROP, research=RES]
source-roots: []
forbidden-names: [archive, archives, deprecated, history, legacy, old, temp, temporary]
ledger: governance/retired.md
reachability-depth: 3
review-days: 365
max-lines: 500
reviewed: 2026-11-05
---

# Documentation policy

System adopts the [DNA Documentation Architecture Standard](https://github.com/tsuuanmi/DNA/blob/main/docs/governance/documentation-architecture.md) by reference. This profile captures System-specific decisions; it does not copy the standard. Its authority applies to this repository, **not** retroactively to `system_1`.

## Scope and conformance

- **Level 1 (minimum)** while the new repository has no product source: typed identities, structural READMEs, forbidden-path checks, and valid relative Markdown links. The local checker also validates declared relations and generated indexes where present.
- Only `governance/`, `proposals/`, and `research/` exist now because those areas hold actual knowledge. Add requirements, architecture, design, decisions, reference, validation, engineering, operations, or security **only with real content**.
- `source-roots` is empty by design. Register each real source root when implementation is introduced, and give each source package a local README.
- The independent documentation standard lives in DNA; the local [agent instructions](../../AGENTS.md) and this policy provide the contributor entry point even when that repository is inaccessible.

## Identity, authority, and links

A proposal has an immutable `PROP-NNNN` identifier; research has `RES-NNNN`. IDs match their filename prefixes and are never reused. Proposal states are `draft`, `proposed`, `accepted`, `rejected`, `implementing`, `implemented`, `superseded`, or `withdrawn`; research states are `active`, `concluded`, or `promoted`.

Documents use an explicit lifecycle front matter where necessary. Use `[[PROP-0001]]` or `[[RES-0001]]` for document relations; router READMEs and paths to source code use relative Markdown links so GitHub renders them. Declare evidence, supersession, implementation, and other typed edges once in front matter rather than relying on prose links. A source path must never be claimed under `covers` before it exists.

## Commands and gates

From the repository root, with Python 3.11+ and no third-party dependencies:

| Command | Purpose |
|---|---|
| `python3 tools/docs.py check` | Structural, identity, internal-link, and metadata checks |
| `python3 tools/docs.py sync` | Regenerate index blocks |
| `python3 tools/docs.py sync --check` | Detect stale generated content without writing |
| `python3 tools/docs.py trace <path-or-ID>` | Inspect authored document edges and their inverses |
| `python3 tools/docs.py impact <base-ref>` | Require a covered document change or a justified PR waiver |

CI runs `check`, `sync --check`, and `impact` on pull requests. A waiver is a PR-body line of the form `docs-unchanged: docs/path.md — reason`. Semantic correctness remains a review responsibility.

## Lifecycle and next adoption step

Retired documents must have their surviving knowledge folded into current documents, references updated, and an append-only row added to [the ledger](retired.md) with a full-text commit reference. No direct deletion or reuse of IDs. Level 2/3 graph enforcement, trace closure completeness, automated retirement and full impact coverage require a separate verified tooling change before raising `level`; the level 1 checker is **not** represented as complete conformance to levels 2 or 3.

No old docs or accepted ADRs are automatically promoted from `system_1`. Their applicability is evaluated in [the bootstrap proposal](../proposals/PROP-0001-next-generation-direction.md).
