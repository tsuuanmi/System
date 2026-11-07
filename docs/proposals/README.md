# Proposals

Proposals capture changes under discussion or delivery. **A proposal is not a shipped feature or accepted specification.** Each proposal has an immutable ID, lifecycle status, and short summary. Promote accepted current facts into the proper canonical area when they become authoritative.

<!-- docs:begin index:proposal -->
- [PROP-0001 — Proposal: first implementation slice](PROP-0001-system-direction.md) — draft — Establish System's goals, architectural questions, and first validation slice without assuming an implementation.
- [PROP-0002 — Proposal: post-MVP-0 roadmap — Brainstorm first](PROP-0002-post-mvp-roadmap.md) — draft — Prioritize three-Worker Brainstorm using existing Claude/Codex adapters, keep Research execution-only for now, and defer Website Workers and stronger verification.
- [PROP-0003 — Proposal: conversation-to-Artifact ingestion (Website Worker, layer 1)](PROP-0003-conversation-ingestion.md) — draft — Take a web chat conversation in as operator-supplied Artifacts (a manifest over file Artifacts) and let a Task carry it as context for Workers, with provenance stated, before any Website Worker exists.
- [PROP-0004 — Proposal: the Host (milestone H)](PROP-0004-host-design.md) — accepted — The design of milestone H (one long-lived Host, ADR-0007), as components each justified by a milestone goal; after a necessity review the operator accepted a serial Host first (R1) and parallelism second (R2), MCP moved to milestone O, and each deferral has a trigger.
- [PROP-0005 — Proposal: the ChatGPT Website Worker](PROP-0005-chatgpt-website-worker.md) — accepted — A Website Worker that runs a step in the operator's signed-in ChatGPT web session through a genuine headed Chrome (patchright-core), returns the answer and its cited links as Artifacts, and records each exchange as a conversation; built on the Host after milestone H's release R1.
<!-- docs:end index:proposal -->
