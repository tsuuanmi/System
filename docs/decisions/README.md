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
- [ADR-0007 — One long-lived Host per machine](ADR-0007-one-long-lived-host.md) — accepted — Replace one short-lived DSH host per CLI command with one long-lived System Host per machine (user-systemd system.service, socket-activated), reached through a Unix-socket API by the CLI and by agents through an MCP adapter; independent steps run in parallel within per-Account limits.
- [ADR-0008 — A `dev` integration branch System may merge into](ADR-0008-dev-integration-branch.md) — accepted — System's own changes integrate into a `dev` branch that System may update and merge into once the required checks pass; only the operator merges `dev` into `main`.
- [ADR-0009 — Goals and Orchestrators](ADR-0009-goals-and-orchestrators.md) — accepted — A Goal is an immutable operator-written Artifact (aim, scope, budget, principles as context) whose spend is folded from its Works, and an Orchestrator is an agent caller reaching the Host through `system mcp`, scoped to one Goal, that may never approve, accept or merge; the Host notifies it when its Works change state.
- [ADR-0010 — The core budget, measured from OC](ADR-0010-core-budget-rebaselined.md) — accepted — The active core's growth budget is measured from 3,403 lines (after milestone OC) instead of the PR #3 baseline of 2,317, at +10% per milestone, and growth over it is paid back within the same milestone; removing features to shrink the core is planned separately.
- [ADR-0011 — Rust ACP Worker Adapter as the first Rust component](ADR-0011-rust-acp-worker-adapter.md) — accepted — Select an optional Rust ACP Worker Adapter as System's first Rust component, reuse the official ACP Rust SDK, and preserve the existing provider-neutral WorkerPort and TypeScript/DSH control plane.
<!-- docs:end index:decision -->
