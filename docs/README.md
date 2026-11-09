# System knowledge router

This index separates **current product intent and accepted architectural
direction** from implementation claims, proposals and exploratory evidence.
System is a fresh product. MVP-0 and Brainstorm are implemented in this
tree ([packages](../packages/README.md), [workflows](../workflows/README.md));
source and tests are the authority for implementation behavior.

| Question | Canonical home | Authority |
|---|---|---|
| Why does System exist? | [Product Charter](requirements/purpose.md) | Accepted product intent |
| What must the smallest product prove? | [MVP requirements](requirements/mvp.md) | Current acceptance contract |
| Which responsibilities belong to System vs DSH? | [Control-plane architecture](architecture/README.md) | Selected target, not shipped |
| Where does Workflow step order live? | [Workflow composition](architecture/workflow-composition.md) | External config, accepted target |
| How do Workers exchange and verify results? | [Artifact-ID and verifier contracts](architecture/artifact-verification.md) | Accepted target, not implemented |
| Why was the control-plane/DSH choice made? | [ADR index](decisions/README.md) | Accepted rationale |
| What external evidence or open tests inform the MVP? | [Research](research/README.md) | Exploratory, non-normative |
| What should a local coding agent implement next? | [PLAN.md](../PLAN.md) | Execution checklist, not a decision |
| How does Brainstorm reuse Workers? | [Brainstorm architecture](architecture/brainstorm-composition.md) | Accepted boundary, implementation in PR #2 |
| What changed in the Work concurrency review? | [Work ownership](architecture/work-ownership-and-recovery.md) | Old file mechanisms, removed in R1 |
| How do I start, stop and diagnose the Host? | [Operations runbook](operations/README.md) | Current procedure |
| What design work remains proposed? | [Proposals](proposals/README.md) | Unaccepted details |
| How is documentation organized and retired? | [Governance](governance/README.md) | Local documentation policy |
| How can another repo bootstrap governance? | [Portable bootstrap](governance/bootstrap.md) | Reusable, product-agnostic |

## Change workflow

The [documentation profile](governance/documentation.md) declares the areas,
what each owns and the conformance level; folder READMEs route rather than
duplicate facts, and generated indexes belong to the documentation tool.

## Reading rules

- One authoritative home per fact; link instead of duplicating it.
- An accepted target architecture does not imply a passing implementation.
- Research observations from an external repository are not System results.
- DSH is the chosen host; particular DSH services still require verification.
- Documentation changes together with behavior once code exists.
