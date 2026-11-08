---
type: requirement
status: active
reviewed: 2026-11-06
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
   Work/Task state, immutable Artifact IDs and decisions remain under System control.
3. **Outcome over activity:** success means accepted, evidenced work, not a
   Worker declaring itself complete. Verification is a **capability contract**
   selected per workflow, not a fixed multi-agent review ritual.
4. **Deterministic handoff, not deterministic generation:** Workers exchange
   immutable Artifact IDs; the controller replays recorded events and
   decisions. Model text may differ between attempts.
5. **Config-defined workflows:** Work/Task is primitive; multi-step workflow
   definitions and order live in independently versioned files, not engine code.
6. **Small active core, expansive optional ecosystem:** correctness-critical
   contracts are explicit; optional capabilities are enabled through DSH
   configuration and can remain installed but inactive.
7. **Reliability before feature breadth:** prioritize safe recovery, effects,
   authority and accounting over the number of services and plugins.
8. **Standards-first and reuse-before-build:** System MUST prefer
   established, fit-for-purpose open protocols, specifications, maintained
   SDKs/libraries and DSH/Cordis capabilities before custom implementations.
   Reimplementing a standard or introducing a new protocol needs a recorded,
   verifiable gap; System-specific Work and Artifact semantics remain
   intentional boundaries. A language or framework preference is not a
   reason to duplicate an adequate existing implementation.
9. **Complexity must earn its place:** every required module needs a measurable
   guarantee or use case. A small *active composition* is the target, not
   deleting code merely to reduce its directory size.
10. **Humans govern exceptions and high-stakes decisions:** automatic
   execution is bounded and explainable, not unconditionally autonomous.
11. **Stay changeable as it grows:** growth is expected; losing the ability
   to change is not. Over time, systems, docs and research swell, drift from
   their first intent and become hard to change (System 1 still runs, but
   its code and docs grew too large to change safely). System manages growth
   with measures it tests: the size of the active core and of the docs is
   recorded at every milestone, growth beyond the agreed budget is justified
   or paid for by removal, and every milestone ends with a pass that proposes
   deletions and simplifications.
12. **Fast, accurate, testable feedback loops:** a change is checked quickly
   and exactly enough to iterate many times. The required checks stay within
   their time budget, every behavior has a test that can fail, and a flaky
   test is a defect fixed before new features.

## Product-wide standards and interoperability requirements

These apply to **new integrations and architecture changes**; they do not
retroactively change MVP-0's already-implemented acceptance evidence.

- **STD-001 — Standards evaluation first:** Before building a protocol,
  transport, format, runtime framework or integration mechanism, System MUST
  evaluate relevant existing standards and maintained implementations,
  including compatibility, licenses, version support, security, cost and
  demonstrated fitness for its actual use case.
- **STD-002 — Prefer reuse:** When a supported standard/SDK or existing DSH
  capability meets the contract, System MUST reuse or adapt it instead of
  making a competing implementation. Exceptions MUST document the precise
  missing requirement, alternatives tested, migration cost and maintenance
  owner in a proposal or accepted decision.
- **STD-003 — Clear, provider-neutral boundaries:** System MUST expose
  provider-agnostic Worker capabilities and results. External protocols
  (such as ACP for interactive agent sessions and MCP for agent tools) MUST
  be used only at their relevant boundaries; an incompatible Worker MUST
  NOT be forced to emulate a protocol it does not support.
- **STD-004 — Demonstrable compliance:** A claim of compatibility MUST
  name the pinned protocol and SDK versions, negotiated features and
  passing conformance/negative tests. Shared JSON encoding or method names
  alone do not establish protocol conformance. Experimental extensions
  MUST remain optional and explicitly gated.
- **STD-005 — No authority leakage:** Reusing a protocol or SDK MUST NOT
  displace System's Work/Attempt/Artifact authority, operator approvals,
  sandbox/credential policy, verified outcomes or effect reconciliation.
  A session/terminal event is observation, not a Work success verdict.
- **STD-006 — Minimal changeable core:** New libraries and components
  MUST have explicit runtime ownership, dependency and rollback plans.
  Prefer optional adapters over mandatory new stacks. Performance claims
  require measurement; implementation language alone is not evidence.

The [optional ACP Worker plugin decision](../decisions/ADR-0011-acp-worker-plugin.md)
selects the official ACP TypeScript SDK and existing DSH subprocess service
instead of an additional Rust bridge. Admission remains dependent on
provider compatibility, process recovery and Artifact/verification tests.

## Success means

- Two unrelated workflows reach verified outcomes through the same core with
  **configuration files**, Worker capability and verifier policy differences only.
- A failed or replaced Worker does not destroy work identity or evidence;
  unknown external effects are reconciled or held for a decision.
- Permission checks and egress restrictions remain enforced across optional
  plugin boundaries.
- The operator can see why an action happened, which Worker performed it,
  the exact **Artifact IDs** created and consumed, and which verifier evidence
  authorized the accepted result.
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
- Treating token arbitrage, complex multi-agent debate, a full project
  board, or a rich dashboard as the reason System exists. Website Workers
  are a planned Worker type, not the product's purpose.
- Creating a new runtime service for every logical boundary.
- Claiming universality without an executed second domain.

## Product / implementation separation

Product purpose is independent of a particular Worker and workflow. Hosting
is **not** undecided: DSH/Cordis is selected for execution/plugin composition
([ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md)).
System-specific work contracts should not expose DSH-internal event types
at their public boundary where a narrow adapter will suffice. Additional
accepted decisions: [Workflow as configuration](../decisions/ADR-0002-work-primitive-configured-workflows.md)
and [artifact/verification contracts](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md).
