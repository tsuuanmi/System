---
related: [governance/documentation-architecture]
---

# Bootstrap another repository from System

The [portable standard](documentation-architecture.md) is self-contained and
product-agnostic. This guide is a bootstrap workflow, not a System runtime
requirement. System's product requirements and proposals are **never** copied
into the target project.

## Create-only scaffold

With Python 3.8+ and a checkout of System available:

    python3 <system-checkout>/tools/bootstrap_docs.py \
      --out <target-repository> --name "My Project"

Existing files are not overwritten. Review printed skipped files and add the
docs router link to an existing root README. The bootstrap copies the portable
standard and checker, writes a **target-local** governance profile, a docs
router, AGENTS.md, a retirement ledger and an initial docs CI workflow.

## Make it ready for System

Run `system bootstrap plan --repo <path>` (it lists each file as `create`, `unchanged` or `conflict`) and do the human
steps it prints. Ask the operator before creating `dev`. The first `.system/checks.yaml` is a direct commit on `dev`
the operator reviews, since admission refuses a Work without one. Write STATUS.md (an `Aim:` line and Items
`- [ ] <id> <title>`) and commit it on `dev` before the push. Run `system bootstrap check` until it passes. Only a
human approves, denies or verifies again: a session never acts as the human and prints the command instead.

## Adaptation rules

1. Update the title, existing source roots, owners and project-specific agent
   invariants. Do not copy System's product decisions or proposals.
2. When there is source, give every configured source package a README and
   declare docs-to-source covers relations.
3. Only accepted requirements and architecture are canonical; put unsettled
   findings under research/ and proposals/.
4. Put the checker in CI and verify its actual conformance level. The bundled
   checker is a **level 1** bootstrap implementation with some extra graph
   checks; it is not a full level 2/3 graph/retirement engine.
5. To upgrade conformance, implement the missing rule catalogue and rerun
   review of all live documentation before increasing level.
6. Once a decision or requirement is accepted, assign stable identifiers;
   never reuse them, including after retirement.

## Standalone adoption

Copying one file: [documentation-architecture.md](documentation-architecture.md) (sections 9 and 10).
