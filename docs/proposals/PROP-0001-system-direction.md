---
id: PROP-0001
type: proposal
status: draft
created: 2026-11-05
summary: Establish System's goals, architectural questions, and first validation slice without assuming an implementation.
evidence: [RES-0001, RES-0002, RES-0003, RES-0004]
related: [ADR-0001, ADR-0002, ADR-0003, ADR-0004]
---

# Proposal: first implementation slice

## What is already decided

The [Product Charter](../requirements/purpose.md) defines System's accepted
mission and philosophy. [ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md)
records the selected **System control-plane / DSH-Cordis host** architecture,
configurable plugin reuse and a common core for **Software Engineering** and
**Research**. [ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md)
and [ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md)
add Work as primitive, external Workflow config, Artifact-ID handoff and
configurable verifier capabilities. [MVP requirements](../requirements/mvp.md) own mandatory behavior.
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

## Decided for MVP-0

[ADR-0004](../decisions/ADR-0004-mvp-0-operating-decisions.md) fixes the
operator model, CLI entry point, human-only approval, external agent Workers
and adapter approach, Work storage in the DSH storage hub, System-owned
push/PR effects, verification policies for both domains, the DSH pin and
the MVP-0/MVP-1 split.

## Open engineering choices

- Minimal DSH profile/bundle and required plugin closure; verify effective
  configuration, not just intended flags.
- The exact external Workflow YAML schema/loader, symbolic reference
  resolution and canonical hashing of the admitted spec.
- Worker adapter contract details, typed Artifact-ID hashing/provenance
  schema, versioned verifier API and effect reconciliation state transitions.
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
4. Load independent Software Engineering and Research config files with
   the **same controller code**; change only Worker and verifier capabilities.
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
