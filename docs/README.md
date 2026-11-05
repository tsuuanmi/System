# System knowledge router

This index distinguishes **current repository truth** from proposals,
exploratory audit evidence, and future implementation. System is a fresh
project; no product runtime or verified production capability is claimed.

| Question | Read | Authority |
|---|---|---|
| How is knowledge organized, checked and retired? | [Governance](governance/README.md) | Current repository policy |
| How can another repository adopt the governance model? | [Portable standard and bootstrap](governance/bootstrap.md) | Reusable, product-agnostic governance |
| What are the present architectural boundaries? | [Architecture](architecture/README.md) | Explicitly draft target model |
| What external evidence informs MVP choices? | [Research](research/README.md) | Exploratory, non-normative |
| What product direction is under consideration? | [Proposals](proposals/README.md) | Proposed, not current behavior |

## Change workflow

Proposals describe unaccepted commitments. Research records evidence and
uncertainty. Promote accepted choices into requirements, architecture, design,
reference and decisions **only when those areas have real content**. Source
and tests, once present, are executable reality.

The [documentation profile](governance/documentation.md) names active areas
and conformance level. Folder READMEs route rather than duplicate knowledge.
Typed relationships belong in front matter. Generated indexes are created by
the documentation tool.

## Reading rules

- Each fact has one home; link instead of repeating it.
- Draft architecture, research and proposals are not deployed functionality.
- Documentation evolves in the same change set as its source behavior.
- Do not copy external architecture or decisions into System by implication.
