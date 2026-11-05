---
type: architecture
status: draft
reviewed: 2026-11-05
---

# System architecture: boundary model

**State: draft target, not a deployed architecture.** This describes the logical
boundaries that an MVP must evaluate. It intentionally chooses no language,
framework, host, storage engine, plugin runtime, or model vendor.

## Logical responsibilities

| Boundary | Responsibility | Must not own |
|---|---|---|
| Client / operator | submit work, state intent, grant sensitive approvals, inspect evidence | silent execution of privileged effects |
| Work controller | track a task, steps, state transitions, deadlines and recovery | provider-specific tool logic |
| Worker adapter | prove capabilities, carry out authorized work, return typed result and usage | long-lived canonical task state |
| State / artifacts | durable inputs, result references, effects, provenance and reconciliation | unverified model claims as trusted facts |
| Policy / effects | decide data egress, tool authority, effect identity and approval | agent-generated exceptions to its own policy |
| Verification | evaluate results against acceptance criteria and record evidence | rewrite the accepted subject while verifying |
| Optional capabilities | additional Worker classes, UIs, gateways, integrations | hidden dependencies in the minimal controller |

These are **evaluation boundaries**, not an adopted implementation topology.

## Candidate invariants to prove

1. Work identity and its material state outlive any single Worker session.
2. An external effect is never automatically replayed when its outcome is
   unknown; recovery reconciles it or fails closed.
3. A Worker's capability and authority are checked before assignment and
   before sensitive side effects.
4. Local data and credentials do not cross an external boundary without an
   explicit, auditable policy decision.
5. The same accepted result is the subject of required checks and independent
   review; a changed result requires new evidence.
6. Resource use, failures, cancellation and approval requests are recorded
   using testable semantics, not estimated from an agent's memory.
7. Optional capabilities can be removed without disabling correctness-critical
   guarantees.

## Proposed end-to-end data flow

    intent -> durable task -> policy + capability admission
           -> Worker -> result/artifact -> verification -> operator decision
                      -> usage/effect ledger -> recovery and inspection

Every arrow represents a boundary to audit. The exact state machine, records,
and deployment remain open. No production code implements this diagram yet.

## Questions for the audit

- What is the smallest state model supporting restart, cancellation,
  idempotent effects and auditability?
- Which boundaries must share a process, and which can be independent plugins?
- Can approval and usage accounting stay correct under provider failures?
- What capability subset proves a non-code workflow without building a full
  board, review organization, browser automation stack or reporting UI?
- What concrete tests demonstrate each invariant at minimal cost?

See [the MVP evidence and audit](../research/RES-0001-audit-baseline.md)
and [the candidate scope](../research/RES-0002-mvp-assessment.md).
