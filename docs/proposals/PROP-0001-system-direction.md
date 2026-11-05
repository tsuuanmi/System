---
id: PROP-0001
type: proposal
status: draft
created: 2026-11-05
summary: Establish System's goals, architectural questions, and first validation slice without assuming an implementation.
evidence: [RES-0001, RES-0002, RES-0003]
related: [ADR-0001]
---

# Proposal: first implementation slice

## What is already decided

The [Product Charter](../requirements/purpose.md) defines System's accepted
mission and philosophy. [ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md)
records the selected **System control-plane / DSH-Cordis host** architecture,
configurable plugin reuse and a common core for **Software Engineering** and
**Research**. [MVP requirements](../requirements/mvp.md) own mandatory behavior.
These are decisions, **not** shipped implementation claims.

This proposal is **draft** only for implementation mechanisms, sequence and
what the first executable vertical slice actually mounts.

## The problem to resolve

How can the smallest DSH composition demonstrate durable work, safe effects,
bounded Worker authority, evidence and two domain-independent workflows
without rebuilding DSH's agent loop, plugin manager or ecosystem?

[RES-0002](../research/RES-0002-mvp-assessment.md) identifies candidate
capability closure. [RES-0003](../research/RES-0003-dsh-control-plane-evaluation.md)
records official DSH capabilities, lifecycle hazards and experiments.

## Open engineering choices

- Minimal DSH profile/bundle and required plugin closure; verify effective
  configuration, not just intended flags.
- Existing DSH persistence/approval/policy services versus a small
  System-owned work ledger where semantic gaps are proven.
- Worker adapter contract, artifact identity and effect reconciliation
  state transitions.
- Thin client entry point (CLI, MCP or both) for end-to-end tests.
- Verification policies for exact code tree and cited research report.
- Safe plugin disable/re-enable with inflight work and version changes.
- Metrics definitions and benchmark reproducibility.

No additional agent runtime, package hierarchy or storage technology is
accepted by implication.

## Proposed build order

1. Inventory a pinned DSH version and produce a minimal effective plugin
   composition. Audit external capability reuse and administrative trust.
2. Implement/compose the narrow Work -> Worker -> Artifact path, using DSH
   mechanisms when the required semantics are satisfied.
3. Add policy/effect gate, crash injection, exact-result verification and
   usage provenance as acceptance gates, not later accessories.
4. Complete one Software Engineering case and one Research case with the
   **same controller code**, varying Worker and verification policies only.
5. Kill/restart, disable/re-enable optional plugins and swap one Worker
   adapter in test fixtures. Record observed limits and runtime costs.
6. Promote tested schemas/decisions into architecture/reference/validation
   documentation; close the proposal after explicit acceptance.

## Non-goals

This proposal does not commit to implementing browser automation, multi-user
hosting, a full board/UI, general workflow DSL, custom model loop or a second
plugin framework. It does not replace the selected DSH foundation.

## Exit

A reviewed, test-backed minimal composition, coherent Work contracts and
passing demonstrations of both domains; unknowns and rejected alternatives
remain explicitly documented. No MVP success is claimed by this PR.
