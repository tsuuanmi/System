# Proposals

Proposals capture changes under discussion or delivery. **A proposal is not a shipped feature or accepted
specification.** Each proposal has an immutable ID, lifecycle status, and short summary. Promote accepted current facts
into the proper canonical area when they become authoritative.

<!-- docs:begin index:proposal -->
- [PROP-0004 — Proposal: the Host (milestone H)](PROP-0004-host-design.md) — accepted — The design of milestone H (one
  long-lived Host, ADR-0007), as components each justified by a milestone goal; after a necessity review the operator
  accepted a serial Host first (R1) and parallelism second (R2), MCP moved to milestone O, and each deferral has a
  trigger.
- [PROP-0005 — Proposal: the ChatGPT Website Worker](PROP-0005-chatgpt-website-worker.md) — accepted — A Website Worker
  that runs a step in the operator's signed-in ChatGPT web session through a genuine headed Chrome (patchright-core),
  returns the answer and its cited links as Artifacts, and records each exchange as a conversation; built on the Host
  after milestone H's checkpoint R1.
- [PROP-0006 — Proposal: a replaceable Orchestrator, and the checks as a
  Sub-workflow](PROP-0006-replaceable-orchestrator-and-code-checks.md) — accepted — An Orchestrator session is
  replaceable like a Worker because its state lives in System (decisions as Artifacts, a brief generated from records,
  live attempt progress with stall notices), and the required checks become a Sub-workflow that Workflows use and that
  can be retried on its own.
- [PROP-0007 — Proposal: Worker policy, faster and clearer checks, and a merge
  queue](PROP-0007-worker-policy-checks-and-merge-queue.md) — accepted — Software Engineering Workers run commands in
  the foreground under a per-attempt budget; the required checks pin their Node, give one-line failure reasons and run
  only what a change touches; System merges into an integration branch through a merge queue that checks the merge
  result.
<!-- docs:end index:proposal -->
