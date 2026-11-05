---
type: requirement
status: active
reviewed: 2026-11-05
---

# System Product Charter

## Identity

**System is a durable work control plane for replaceable AI Workers.**
It governs the continuity, authorization, inspection and verification of work
across Worker runtimes, rather than being another general-purpose model loop.

**Tagline:** Work persists. Workers change. Humans govern.

This is **the current product intent**, not a claim that the product has been
implemented. The control-plane decision and selected DSH host are recorded in
[ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md).

## Mission

Make AI work **durable, portable, verifiable and governable** across replaceable
Workers, with minimal operator intervention and explicit authority.

## Vision

A person delegates an outcome, not a sequence of tool commands. Replaceable
Workers can collaborate or take over work without losing its artifacts,
history or acceptance criteria. The person retains control of material risks
and decisions, instead of becoming a bottleneck for routine operations.

## Fundamental purposes

**P1 — Work continuity.** Work and essential artifacts outlive a Worker
session, process restart and provider change. A failed Worker must not erase
the identity of the task or force unsafe effect replay.

**P2 — Workflow generality.** The same control-plane core supports different
domains. For MVP this must be demonstrated with **Software Engineering** and
**Research** workflows, not just different coding templates.

**P3 — Bounded autonomy.** Authorized routine work advances without an
approval for every command; privileged or uncertain effects are subject to
explicit policy and operator authority. Autonomy is never permission to
evade policy.

## Philosophy

1. **Work-first, not agent-first:** work and its outcomes are the domain model;
   Workers and models are replaceable execution resources.
2. **State outside Workers:** conversations may help execution, but canonical
   work state, artifact references and decisions remain under System control.
3. **Outcome over activity:** success means accepted, evidenced work, not a
   Worker declaring itself complete.
4. **Small active core, expansive optional ecosystem:** correctness-critical
   contracts are explicit; optional capabilities are enabled through DSH
   configuration and can remain installed but inactive.
5. **Reliability before feature breadth:** prioritize safe recovery, effects,
   authority and accounting over the number of services and plugins.
6. **Reuse before build:** DSH/Cordis is the chosen host and composition
   foundation; reuse its mechanisms and community ecosystem instead of
   recreating them without evidence.
7. **Complexity must earn its place:** every required module needs a measurable
   guarantee or use case. A small *active composition* is the target, not
   deleting code merely to reduce its directory size.
8. **Humans govern exceptions and high-stakes decisions:** automatic
   execution is bounded and explainable, not unconditionally autonomous.

## Success means

- Two unrelated workflows reach verified outcomes through the same core with
  configuration and Worker differences only.
- A failed or replaced Worker does not destroy work identity or evidence;
  unknown external effects are reconciled or held for a decision.
- Permission checks and egress restrictions remain enforced across optional
  plugin boundaries.
- The operator can see why an action happened, which Worker performed it,
  what artifact was produced, and why the result was accepted.
- Operator interventions, task completion, restart behavior and usage
  accounting can be measured. Numeric release targets require measurement
  definitions and separately accepted evidence.

For the minimum product acceptance checks, see [MVP](mvp.md).
External reference targets R1–R5 are recorded in
[research](../research/RES-0001-audit-baseline.md); they are **not** shipped
System results or automatically adopted release thresholds.

## Explicit non-goals

- Training or creating a foundation model, a new agent loop, or a replacement
  for the DSH plugin manager.
- A proprietary replacement for every community plugin or model adapter.
- Treating Website Workers, token arbitrage, complex multi-agent debate,
  a full project board, or a rich dashboard as the reason System exists.
- Creating a new runtime service for every logical boundary.
- Claiming universality without an executed second domain.

## Product / implementation separation

Product purpose is independent of a particular Worker and workflow. Hosting
is **not** undecided: DSH/Cordis is selected for execution/plugin composition
([ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md)).
System-specific work contracts should not expose DSH-internal event types
at their public boundary where a narrow adapter will suffice.
