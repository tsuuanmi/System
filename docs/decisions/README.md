# Decisions

This area preserves **durable accepted or rejected architectural rationale**.
Accepted decisions explain why the current product direction was chosen;
implementation details belong in requirements and architecture. An ADR's
acceptance does not imply its code exists.

<!-- docs:begin index:decision -->
- [ADR-0001 — Control plane on DSH/Cordis](ADR-0001-control-plane-on-dsh.md) — accepted — Select System as a durable work control plane, DSH/Cordis as host and configurable plugin foundation, and two workflow-agnostic MVP proofs.
- [ADR-0002 — Work is the primitive; Workflow is configuration](ADR-0002-work-primitive-configured-workflows.md) — accepted — Make Work/Task the execution primitive and Workflow an external, versioned configuration composition of steps, dependencies, Worker capabilities and verification policies.
- [ADR-0003 — Artifact IDs are the handoff protocol; verification is pluggable](ADR-0003-artifact-ids-and-verification-contracts.md) — accepted — Require immutable Artifact-ID handoff, deterministic orchestration from pinned inputs and persisted decisions, and pluggable exact-subject verification contracts per workflow.
- [ADR-0004 — MVP-0 operating decisions](ADR-0004-mvp-0-operating-decisions.md) — accepted — Fix the MVP-0 operating choices — single operator, human-only approval, external agent Workers in per-attempt worktrees, Work state in the DSH storage hub, System-owned push/PR effects, and deferred sandboxing.
- [ADR-0005 — Workers use subscription tokens, not API keys](ADR-0005-subscription-tokens-for-workers.md) — accepted — Workers authenticate with the operator's Claude and ChatGPT subscriptions through System-held tokens instead of provider API keys; this replaces ADR-0004 decision 7.
- [ADR-0006 — The MVP-0 Workflow vocabulary](ADR-0006-workflow-vocabulary-for-mvp-0.md) — accepted — Bring into MVP-0 the Workflow fields the two domain proofs needed (inputs, version, instructions, effect, approval), which ADR-0004 had deferred, and record the rules that bound them.
<!-- docs:end index:decision -->
