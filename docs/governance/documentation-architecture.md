# Portable Documentation Architecture Standard

A **repository-agnostic** contract for documents as a knowledge system: one
authoritative home per fact, typed knowledge, explicit relationships, generated
indexes, and evidence-based retirement. This document is **the reusable standard**.
A consuming repository needs no System product code or runtime.

To bootstrap another project, follow [the bootstrap guide](bootstrap.md).
The adopter keeps its own repository profile; this standard contains no System
product constraints. Keywords MUST, SHOULD, and MAY are normative.

## 1. Knowledge and authority

| Area / type | Owns | Authority |
|---|---|---|
| requirements / requirement | required behavior, verifiable outcomes | canonical / living |
| architecture / architecture | responsibility boundaries, invariants, data flow | canonical / living |
| design / design | implemented or explicitly targeted mechanisms | canonical / living |
| reference / reference | exact APIs, schemas, formats and vocabulary | canonical / living |
| validation / validation | test evidence, thresholds and limitations | canonical / living |
| engineering / engineering | build, tests, CI, release and dependencies | canonical / living |
| operations / operations | readiness, runbooks and playbooks | canonical / living |
| security / security | trust boundaries, threat model, supply chain | canonical / living |
| governance / governance | document policy, ownership and retention | canonical / living |
| decisions / decision | accepted and rejected durable rationale | historical |
| proposals / proposal | changes awaiting or undergoing acceptance | evolutionary |
| research / research | experiments, comparisons, unadopted findings | exploratory |

Only create an area under docs/ if it has real content. Research and proposals
are **never** silently treated as requirements or deployed architecture.
Executable source and tests remain the final observable reality, not a
documentation class. If source and normative docs conflict, reconcile both.

**DOC-AUTH-001:** One fact MUST have one canonical home. Readers link to it
instead of copying it; current behavior and proposed behavior MUST be labeled.
**DOC-AUTH-002:** Any behavior change MUST update its governing documentation
in the same change. An obsolete fact is corrected in place or retired.
**DOC-AUTH-003:** Source-local documentation MUST remain with the owning source
package; do not mirror a source tree under docs/src/.

## 2. Identity and metadata

Every docs/ Markdown document has a path identity: strip docs/ and .md; an
area README identifies the folder, not a separate topic. A typed document MAY
have an ID prefix configured by the profile. For such types, an ID is required,
unique, never reused, and the filename starts with ID and a dash. A bold list
item ID (for example SRS-CORE-001) defines that item in its document.

Metadata uses a strict flat YAML subset between --- lines. Values are scalars,
inline lists, or lists of scalar items; dates are YYYY-MM-DD. Do not add
front matter to every README solely for decoration.

Supported keys: type, status, id, date, created, summary, owners, reviewed,
implements, decided-by, covers, verified-by, supersedes, evidence, family,
related, implementation, unverified, family-labels. The repository profile adds
level, areas, id-prefixes, source-roots, forbidden-names, ledger,
reachability-depth, review-days, max-lines.

| Type | Valid status |
|---|---|
| canonical/living types | draft, active, deprecated (implicit active) |
| decision | proposed, accepted, rejected, superseded, superseded-in-part, deprecated |
| proposal | draft, proposed, accepted, rejected, implementing, implemented, superseded, withdrawn |
| research | active, concluded, promoted |

**DOC-ID-001:** Every document MUST resolve to exactly one declared type,
through front matter or its registered area; metadata MUST use known keys.
**DOC-ID-002:** Typed IDs MUST match filename prefix, be unique across all
live documents and retired ledger entries, and MUST NEVER be reused.
**DOC-ID-003:** Lifecycle statuses MUST match type. ID-bearing documents MUST
declare id and status; proposals also declare creation dates.

## 3. Cross-references and trace graph

Use a document path identity or a configured ID as the target of a wikilink,
for example the illustrative syntax below:

    [[architecture/data-flow]]
    [[ADR-0012]]
    [[SRS-CORE-001]]
    [[ADR-0012|rationale]]

A target resolves first by ID, then by path identity, then by unique basename.
Relative Markdown links remain appropriate for repository files, external
URLs, router READMEs, and generated indexes. Keep links resolvable on GitHub
where humans must navigate.

Only the **downstream** document authors a typed relation:

| Field | Authored in | Points to |
|---|---|---|
| implements | architecture/design/reference | requirement item or namespace |
| decided-by | living document | governing decision |
| covers | any | actual source/test/config paths (globs) |
| verified-by | requirement/validation | actual tests or validation docs |
| supersedes | newer proposal/decision | prior record |
| evidence | proposal/decision | research |
| related | any | exceptional untyped relation |

The checker calculates inverses; no one maintains backlinks by hand.

**DOC-LNK-001:** Relative Markdown links MUST stay inside the repository and
resolve to existing paths.
**DOC-LNK-002:** Document wikilinks MUST resolve uniquely.
**DOC-LNK-003:** Bare document/requirement IDs in prose MUST resolve to a live
document or retired ledger entry.
**DOC-LNK-004:** Repository paths named as real paths MUST exist; examples
MUST be marked as such.
**DOC-LNK-005:** Typed relation targets MUST resolve. covers and verified-by
globs MUST match at least one existing file.
**DOC-LNK-006:** A living document citing a decision or requirement MUST
declare that dependency in decided-by or implements, not only in prose.

A conforming advanced tool SHOULD provide trace <path-or-ID>, computing closure
across authored edges and their inverses, requirement items, tests, source
ownership README, decisions and supersession.

**DOC-GRF-001:** Supersession status MUST agree with successor links.
**DOC-GRF-002:** Every doc MUST be reachable from docs/README.md via routers
within the profile's configured depth (default 3).
**DOC-GRF-003:** covers globs MUST resolve.
**DOC-GRF-004 (warning):** Each requirement item SHOULD have implementing
documentation and a verifier; exceptions MUST state why.
**DOC-GRF-005 (warning):** A decision governing no living content SHOULD be
reviewed for retirement.

## 4. Routers and ownership

The root README introduces the project; docs/README.md routes readers by role,
authority and task. Each docs/ folder README states what belongs, what does
not, and canonical entry points; prefer generated member lists. Every source
package README states responsibility, non-responsibility, entry points,
dependency direction and governing docs. Source-specific APIs live with code.

**DOC-STR-001:** Every docs/ directory MUST have exactly one README.md.
**DOC-STR-002:** Every source package in configured source roots MUST have a
README.md.
**DOC-STR-003:** No docs/src mirror; no topic.md alongside topic/README.md.
**DOC-STR-004:** Current-state files and folders MUST avoid the profile's
forbidden names (for example archive, history, legacy, old, temp).

## 5. Generated knowledge

Derived indexes, status tables, decision-family maps, coverage and inverse
edges MUST be produced, never maintained manually. Generator blocks use the
exact opening and closing markers shown below (illustrative):

The opening marker is `<!-- docs:begin index:proposal -->` and the closing
marker is `<!-- docs:end index:proposal -->`. The generator owns the lines
between them.

A portable implementation SHOULD provide sync, sync --check, check, trace,
impact, candidates and retire. See section 8 for the minimum contract.
**DOC-GEN-001:** sync --check MUST fail if generated blocks are stale.
**DOC-GEN-002:** A table derivable entirely from metadata MUST be generated.

## 6. Retention, lifecycle, and evidence

Live full-text document -> one retired-ledger row -> full text in a named Git
commit. The append-only ledger MUST record id, title, outcome, superseded-by,
retired date and the last full-text commit:path. Add a durable
docs-retired/<date> tag when retiring. An ID resolves to a live file or a ledger
row; a removed path must not be a live target.

Retire only after: (a) an allowed terminal status, (b) current facts are folded
into living docs, and (c) current links are rewritten to a successor/ledger
before deletion. Partial supersession stays live until the surviving part is
promoted. Do not keep compatibility copies unless stable published URLs are a
documented requirement.

**DOC-RET-001:** Retired IDs resolve through the ledger.
**DOC-RET-002:** Ledger references and row fields are valid.
**DOC-RET-003 (warning):** Unexplained ID gaps are recorded as never-committed
or retired explicitly.
**DOC-RET-004:** Retired IDs MUST NEVER be reused.
**DOC-FRS-001 (warning):** Living docs exceeding review-days are flagged.
**DOC-FRS-002 (warning):** Living docs exceeding max-lines are flagged.

Research is promoted to proposals/decisions or retired with its findings
preserved in a current home. A shipped proposal moves its current contractual
truth to canonical docs and is then eligible to retire.

## 7. Change-impact contract

A change to a file matched by a document's covers globs MUST modify that
document in the same diff, unless the change describes a justified waiver:

    docs-unchanged: docs/reference/api.md — only formatting changed

**DOC-IMP-001:** Every changed, covered source path has a corresponding
documentation change or an explicit waiver. CI evaluates against the PR base.

## 8. Conformance and reusable tool contract

| Level | Required errors |
|---|---|
| 1 / minimum | DOC-STR-*, DOC-ID-*, DOC-LNK-001 |
| 2 / standard | Level 1 + DOC-LNK-002..006, DOC-GRF-001..003, DOC-GEN-* |
| 3 / full | Level 2 + DOC-RET-*, DOC-IMP-001; warnings as defined |

A conforming checker MUST emit rule ID + location + severity, and SHOULD
continue structural checking when front matter is malformed. Every repository
MUST accurately disclose which rules its tool enforces; never relabel a
partial checker as full conformance.

Recommended command contract:

| Command | Contract |
|---|---|
| check | validate all supported rules |
| sync [--check] | write or verify generated blocks |
| trace <path-or-ID> | print typed-edge closure |
| impact <base-ref> | enforce covered-path edits |
| retire <path> --outcome "..." | verify retirement, record ledger, rewrite links |
| candidates | list obsolete or stale documents |

## 9. Repository profile and agent contract

Each adopter puts its **local** profile in
docs/governance/documentation.md. Example only:

    ---
    level: 1
    areas: [governance=governance, requirements=requirement]
    id-prefixes: [decision=ADR, proposal=PROP, research=RES]
    source-roots: [src]
    forbidden-names: [archive, deprecated, history, legacy, old, temp]
    ledger: governance/retired.md
    reachability-depth: 3
    review-days: 365
    max-lines: 500
    ---

Actual areas, ID prefixes, and source roots MUST reflect the target repository;
never copy another repository's taxonomy or product facts unquestioningly.

AGENTS.md MUST route coding agents through root README, docs/README.md,
the trace closure, the nearest source README and then tests. It MUST forbid
treating research/proposals as implemented truth, duplicating facts,
hand-editing generated blocks, and bypassing required checks. It SHOULD name
the exact local check, sync, trace and impact commands.

## 10. Adoption checklist

1. Copy this **portable standard** into docs/governance/.
2. Create the profile, a docs router, and README for each area with content.
3. Create AGENTS.md, an empty retirement ledger, and a local check/sync tool.
4. Inventory existing knowledge; classify authority, retain one home per fact,
   and assign never-reused IDs.
5. Declare typed relationships and resolve all links.
6. Generate indexes; install check, sync --check and impact in CI.
7. Raise conformance level **only when implementation and CI prove it**.

The [bootstrap guide](bootstrap.md) provides a practical, create-only
scaffolding workflow, including an example independent project.
