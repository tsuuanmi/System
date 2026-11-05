---
id: PROP-0001
type: proposal
status: draft
created: 2026-11-05
summary: Establish System's goals, architectural questions, and first validation slice without assuming an implementation.
evidence: [RES-0001, RES-0002]
---

# Proposal: System direction

## Motivation

System aims to make AI work portable among Workers while keeping the operator
in control of significant decisions. **This document is a draft**, not a
shipped specification. See the [MVP assessment](../research/RES-0002-mvp-assessment.md)
for auditable candidates rather than copying another system's product scope.

## Proposed outcomes

1. **Artifact-based handoff:** meaningful inputs, outputs and decisions survive
   the Worker and allow independently chosen Workers to continue the task.
2. **Workflow-agnostic core:** the execution model serves at least one code
   and one non-code workflow without controller changes.
3. **Operator attention is scarce:** routine actions within explicit policy
   proceed, but sensitive effects and material choices remain governed.
4. **Small, inspectable core:** keep correctness-critical guarantees in clear
   boundaries and allow optional capabilities to disappear cleanly.
5. **Reliability before breadth:** restart recovery, side-effect integrity,
   usage correctness and outcome quality take priority over feature count.

No particular host, framework, plugin API, language, vendor, or release
version is selected. Reference research is non-normative.

## Decisions needed for the MVP

- Which Worker contract and single end-to-end task flow are indispensable?
- Which durable records and effect-reconciliation states are necessary?
- Where are approvals, egress, credentials and usage trust boundaries enforced?
- What minimal verification makes a result safe to accept or act on?
- Which host/runtime choices can meet the same tests with less complexity?
- Are the R1–R5 reference targets appropriate for this new product, or do they
  require new definitions and thresholds?

[The boundary model](../architecture/boundaries.md) and [[RES-0002]]
frame the review. An accepted architectural choice should be recorded in a
new decision document with alternatives and tests.

## Proposed first vertical slice

1. Agree minimum tasks, success measures and trust constraints.
2. Execute one real Worker from a client through policy, a durable record and
   a result reference.
3. Prove restart/cancel safety and no duplicate external effects.
4. Verify usage against a credible independent oracle.
5. Run a small non-code task through the same controller without engine
   modifications.
6. Measure runtime overhead and operational effort with repeatable evidence.

## Non-goals of this documentation PR

No executable product is claimed, architecture is not frozen, and old
implementation features are not included by default. The audit does not make
new feature commitments until the operator reviews the evidence.

## Acceptance

Choose MVP outcomes, the smallest proven capability closure, boundaries and
measurable acceptance tests; promote accepted facts into canonical
requirements and architecture. Everything else stays research or proposal.
