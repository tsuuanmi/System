---
level: 1
areas: [governance=governance, proposals=proposal]
id-prefixes: [proposal=PROP]
source-roots: []
forbidden-names: [archive, archives, deprecated, history, legacy, old, temp, temporary]
ledger: governance/retired.md
reachability-depth: 3
review-days: 365
max-lines: 500
reviewed: 2026-11-05
---

# Documentation policy

System adopts the [DNA Documentation Architecture Standard](https://github.com/tsuuanmi/DNA/blob/main/docs/governance/documentation-architecture.md) by reference. This document records only System-specific choices; the standard is not duplicated here.

## Scope and conformance

- **Level 1 (minimum)** while there is no product source: typed identity, structural READMEs, forbidden-path checks, and relative Markdown links. The local checker additionally validates declared relations and generated indexes where present.
- Only `governance/` and `proposals/` exist initially, because they hold actual knowledge. Add requirements, architecture, design, decisions, reference, validation, engineering, operations, security, or research **when they have real content**.
- `source-roots` is empty intentionally. Register each real source root when implementation begins, and give each source package its own README.
- The documentation standard is maintained in DNA; this repository keeps its own contributor workflow and runnable checks.

## Identity, authority, and links

Proposals have immutable `PROP-NNNN` identifiers. IDs match their filename prefixes and are never reused. Proposal states are `draft`, `proposed`, `accepted`, `rejected`, `implementing`, `implemented`, `superseded`, or `withdrawn`.

Documents use explicit lifecycle front matter where useful. Use `[[PROP-0001]]` for document-ID relationships; router READMEs and source paths use relative Markdown links to render on GitHub. Typed edges such as `evidence`, `supersedes`, `implements`, and `covers` belong in front matter rather than only in prose. A `covers` glob must refer to existing paths.

## Commands and gates

From the root, using Python 3.11+ without third-party dependencies:

| Command | Purpose |
|---|---|
| `python3 tools/docs.py check` | Structure, identity, internal links, metadata |
| `python3 tools/docs.py sync` | Regenerate supported index blocks |
| `python3 tools/docs.py sync --check` | Detect stale generated content |
| `python3 tools/docs.py trace <path-or-ID>` | Inspect declared document relations |
| `python3 tools/docs.py impact <base-ref>` | Require updates for changed covered paths or justified PR waivers |

CI runs `check`, `sync --check`, and, on pull requests, `impact`. An impact waiver is a PR-body line such as `docs-unchanged: docs/path.md — reason`. Reviewers remain responsible for semantic correctness.

## Lifecycle

Retired documents must have surviving knowledge promoted into current documentation and references updated; add an append-only row to [the ledger](retired.md), including a full-text commit reference. Never reuse identifiers or delete documents without recording why.

Level 2/3 conformance, complete trace closure, automated retirement, and expanded impact checks require a subsequent verified tooling change before increasing `level`. The present checker is deliberately not described as full level 2 or 3 conformance.
