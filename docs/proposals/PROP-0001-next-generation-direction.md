---
id: PROP-0001
type: proposal
status: draft
created: 2026-11-05
summary: Define the upgrade goals, architectural decision gates, and first validation slice for System without inheriting system_1 as current behavior.
evidence: [RES-0001]
---

# Proposal: next-generation System direction

## Context

[System](../../README.md) is intended as an upgraded successor to [system_1](https://github.com/tsuuanmi/system_1), not a copy of its current codebase. The predecessor's capabilities, architectural decisions, and recent simplification proposals are input evidence ([[RES-0001]]), **not adopted decisions** in this repository.

## Proposed outcomes (not yet requirements)

1. Keep the central value: choose an appropriate AI Worker for each job, balancing capabilities, quota, cost, and data locality.
2. Favor a **small, auditable execution core** over growing orchestration complexity. Keep optional capabilities replaceable and removable.
3. Preserve durable work and explicit handoffs so recovery does not depend on one model session; define idempotency and reconciliation at side-effect boundaries.
4. Keep permissions, egress, approvals, and accounting observable, bounded, and reviewable by the operator.
5. Use measured reliability, latency, resource cost, and developer effort rather than number of plugins as the success criteria.

These are discussion goals. None imply that a particular runtime, plugin API, implementation language, provider, or compatibility commitment has been chosen.

## Decisions required before implementation

- **Runtime:** reuse a minimal DSH/Cordis host, adapt it, or choose another host? Compare maintenance burden, isolation, performance, and integration cost.
- **Plugin boundary:** which correctness guarantees belong in a small common contract, and which optional capabilities can unload cleanly?
- **Worker interface:** what minimal capability, cancellation, tool authorization, result, and usage contracts can serve browser, agent, API, and local Workers?
- **Durability:** what event/artifact state is truly required to restart work without replaying side effects?
- **Migration:** which user-facing workflows, state formats, and CLI behaviors merit compatibility? No automatic compatibility is presumed.
- **Proof:** what end-to-end vertical slice and benchmark would falsify the proposed simplification?

Each durable choice should be recorded in this repository as a new decision when accepted, with evidence and explicit alternatives. The predecessor's ADR numbers are **not** reused as local decisions.

## Suggested first vertical slice

1. Record a small set of measurable requirements and trust boundaries.
2. Implement one local/agent Worker behind a minimal interface, a persistent task record, and a client entry point.
3. Demonstrate start, completion, restart recovery, cancellation, denied external side effects, and usage reporting.
4. Benchmark runtime overhead, task latency, resource use, and failure recovery against a pinned `system_1` revision where comparisons are meaningful.
5. Add browser/API Workers and richer multi-agent workflows only after the minimal core and verification strategy are credible.

## Not in scope for this documentation PR

No production architecture is chosen, no previous behavior is declared shipped, no legacy documentation is bulk-imported, and no source or migration of stored credentials is attempted.

## Exit criteria for this proposal

The operator reviews and accepts or rejects the scope, chooses the first architecture decisions, and identifies tests and ownership for the first slice. Only then promote accepted parts into canonical requirements, architecture, and design.
