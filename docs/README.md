# System knowledge router

This index separates **current product intent and accepted architectural
direction** from implementation claims, proposals and exploratory evidence.
System is a fresh project with no running product code in this repository.

| Question | Canonical home | Authority |
|---|---|---|
| Why does System exist? | [Product Charter](requirements/purpose.md) | Accepted product intent |
| What must the smallest product prove? | [MVP requirements](requirements/mvp.md) | Current acceptance contract |
| Which responsibilities belong to System vs DSH? | [Control-plane architecture](architecture/README.md) | Selected target, not shipped |
| Why was the control-plane/DSH choice made? | [ADR index](decisions/README.md) | Accepted rationale |
| What external evidence or open tests inform the MVP? | [Research](research/README.md) | Exploratory, non-normative |
| What design work remains proposed? | [Proposals](proposals/README.md) | Unaccepted details |
| How is documentation organized and retired? | [Governance](governance/README.md) | Local documentation policy |
| How can another repo bootstrap governance? | [Portable bootstrap](governance/bootstrap.md) | Reusable, product-agnostic |

## Change workflow

Requirements define **what** needs to be proven, architecture owns
**responsibility boundaries**, decisions preserve **why** choices were made,
research retains evidence and uncertainty, and proposals contain unaccepted
work. Executable source and tests, when present, determine actual behavior.

The [documentation profile](governance/documentation.md) declares active
areas and conformance level. Folder READMEs route rather than duplicate facts.
Typed relationships belong in front matter; generated indexes belong to the
documentation tool.

## Reading rules

- One authoritative home per fact; link instead of duplicating it.
- An accepted target architecture does not imply a passing implementation.
- Research observations from an external repository are not System results.
- DSH is the chosen host; particular DSH services still require verification.
- Documentation changes together with behavior once code exists.
