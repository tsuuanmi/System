# System knowledge router

This index separates **current product intent and accepted architectural
direction** from implementation claims, proposals and exploratory evidence.
System is a fresh product. MVP-0 and Brainstorm are implemented in this
tree ([packages](../packages/README.md), [workflows](../workflows/README.md));
source and tests are the authority for implementation behavior.

| Question | Canonical home | Authority |
|---|---|---|
| Why does System exist, and what must the smallest product prove? | [Product Charter](requirements/purpose.md) | Accepted product intent, with the success criteria |
| Which responsibilities belong to System vs DSH? | [Control-plane architecture](architecture/control-plane.md) | Accepted architecture; implemented, source and tests rule |
| What does each architecture page cover? | [Architecture index](architecture/README.md) | Index of the architecture pages |
| Where does Workflow step order live? | [Workflow composition](architecture/workflow-composition.md) | External config; `system.workflow/v1` implemented |
| How do Workers exchange and verify results? | [Artifact-ID and verifier contracts](architecture/artifact-verification.md) | Accepted semantics; contracts implemented |
| How does one process own every Work, and how does it recover? | [Host](architecture/host.md) | Implemented; the crash and recovery invariants |
| How is a Work's history recorded and folded? | [Work record](architecture/work-record.md) | Implemented; events and derived facts |
| Why was the control-plane/DSH choice made? | [ADR index](decisions/README.md) | Accepted rationale |
| What external evidence or open tests inform the MVP? | [Research](research/README.md) | Exploratory, non-normative |
| What is finished, and what is open? | [STATUS.md](../STATUS.md), [PLAN.md](../PLAN.md) | STATUS.md: open Items; PLAN.md: finished milestones, standing decisions, future triggers |
| What do System's terms mean? | [GLOSSARY.md](../GLOSSARY.md) | The vocabulary |
| How does Brainstorm reuse Workers? | [Brainstorm architecture](architecture/brainstorm-composition.md) | Implemented; `workflows/brainstorm.yaml` |
| How do I start, stop and diagnose the Host? | [Operations runbook](operations/README.md) | Current procedure |
| How is documentation organized and retired? | [Governance](governance/README.md) | Local documentation policy |
| How can another repo bootstrap governance? | [Portable bootstrap](governance/bootstrap.md) | Reusable, product-agnostic |

Rules for changing the docs: the [documentation profile](governance/documentation.md).
