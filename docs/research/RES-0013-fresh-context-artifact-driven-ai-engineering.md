---
id: RES-0013
type: research
status: active
date: 2026-11-16
summary: Research fresh-context execution, durable Artifact handoff, vertical Work slices, feedback and independent verification.
related: [ADR-0002, ADR-0003, ADR-0012]
---

# Fresh-context, artifact-driven AI engineering workflow

**Status: exploratory research, not an adopted design or a claim of shipped behavior.**
This note studies Matt Pocock's AI engineering workshop and maps its useful
ideas to System's existing Work, Attempt, Artifact and verifier contracts.
The preferred direction is to make context disposable and durable evidence
authoritative, not to introduce a second agent state store or an orchestration
framework.

## Sources and evidence limits

- [Matt Pocock, AI Engineer Workshop 2026](https://www.aihero.dev/ai-engineer-workshop-2026~dwnll):
  official workshop outline covering grill-me, PRD, vertical slices, Ralph,
  test-driven development and AFK execution.
- [Workshop exercise repository](https://github.com/mattpocock/ai-engineer-workshop-2026-project):
  an example implementation, not a dependency required by System.
- Workshop transcript provided for this research on 2026-11-16:
  primary account of the discussion, demonstrations and caveats.
- System's [Artifact and verifier contract](../architecture/artifact-verification.md),
  [Work recovery contract](../architecture/work-ownership-and-recovery.md),
  and [previous reuse-first research](RES-0012-reuse-first-research-2026-11-14.md).

The workshop is a practitioner account, not a controlled evaluation.
In particular, its approximately 100K-token "smart zone" is a subjective
heuristic, not a universal model threshold. Claims about review quality,
TDD, module design and autonomous execution need System-specific evaluation.

## Findings from the workshop

1. **Align before coding.** An interviewing ("grill-me") step resolves
   assumptions with humans, records choices and rejected alternatives, and
   produces a destination document (PRD or equivalent).
2. **Decompose by verifiable vertical slices.** A slice should expose a
   testable end-to-end behavior, rather than waiting until all database,
   backend and UI layers are written. Its blocking relations form a DAG
   whose ready items can run concurrently.
3. **Make feedback executable.** Red-green-refactor, type checks, integration
   checks and QA surface errors during implementation, not only after it.
   Passing unit tests alone is insufficient: the workshop demonstration
   still found a missing database migration in manual QA.
4. **Treat context as a budget.** Short, bounded tasks and isolated exploratory
   subagents reduce irrelevant context. The presenter prefers restarting
   fresh sessions to repeatedly compacting a growing conversation.
5. **Separate implementation from independent evaluation.** A fresh-context
   reviewer should examine actual changes, tests and specified requirements
   instead of inheriting the implementer's working assumptions.
6. **Keep humans responsible for intent and consequential QA.** Agents can
   implement many well-scoped tasks autonomously; architecture, tradeoffs,
   user experience and acceptance still need explicit ownership.
7. **Design testable module boundaries.** Deep modules with small interfaces
   and meaningful behavior can improve test boundaries and reduce the
   dependency surface that a Worker must understand.
8. **Avoid document rot.** Temporary plans and historical PRDs must not become
   implicit, forever-current facts about the codebase.

These are observations from the workshop, not proposed new System product
requirements. The presenter showed a Ralph-style execution loop and an
isolated parallel-agent setup; System should study the transferable
contracts, not copy that runtime.

## Fit with System's existing contracts

System already defines durable Work, retry-specific Attempt and immutable
Artifact identities. [ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md)
explicitly rejects conversation history and transient output paths as the
inter-Worker handoff contract. The implemented artifact package and verifier
registry are described in [Artifact verification](../architecture/artifact-verification.md).
The [recovery design](../architecture/work-ownership-and-recovery.md)
requires completed step outputs to be reused, unknown attempts to receive
new IDs, and state to be reconstructed from recorded events rather than
regenerated model responses.

**Research hypothesis:** a Worker execution can be restarted with a fresh
context assembled from *authorized, pinned, relevant* durable records,
without relying on the previous model conversation as implicit state.
The assembly may be a derived view over existing records; it does not
justify a new database, scheduler, engine or artifact type by itself.

### Candidate context-rehydration contract (not implemented here)

| Input to a new Attempt | Source of truth | Guardrail |
|---|---|---|
| Work identity, current step, selected ready Item | Stored Work events and pinned workflow | Never infer state from chat |
| Goal, constraints, accepted/rejected decisions | Authorized Task and linked Artifacts | Distinguish current facts from historical notes |
| Inputs, prior outputs and their provenance | Immutable Artifact IDs | Resolve only permitted references |
| Repository and module context | Exact base revision and relevant checked-in docs/tests | Avoid stale branch-name-only evidence |
| Acceptance criteria and policies | Pinned criteria and policy references | No mutable goalposts during retry |
| Previous failure and verifier evidence | Verdict and evidence Artifact IDs, Attempt history | Include actionable failure, not entire logs by default |
| Worker capabilities and resource limits | Existing configured Worker/Work controls | Never serialize secrets into prompt artifacts |

The controller would prepare a **bounded context view** for each Attempt:
the minimum references and excerpts needed for its particular step.
A new reviewer gets the same pinned task/criteria and exact subject
Artifact, but independently constructs its review context. Source logs,
large transcripts and irrelevant previous reasoning are retrieved only
when explicitly required by the task and authorized.

A reset does **not** erase Work progress, open dependencies, prior verdicts
or unresolved failures. It only replaces the transient LLM session.
Compaction can still be an optimization *within* a session; it must not
be the sole source of durable continuation.

### Proposed end-to-end loop

1. Human or an authorized planner clarifies the goal, assumptions,
   out-of-scope choices and acceptance criteria.
2. Decompose the goal into small, verifiable, dependency-aware Work Items.
   Prefer a vertical slice when it yields earlier integrated evidence.
3. Select an unblocked Item and dispatch a fresh Attempt using pinned
   Work/Artifact references and a bounded context view.
4. Worker implements, preferably test-first where suitable, and records
   changes, check outputs and other evidence as durable artifacts.
5. Independent verifier evaluates the **exact subject Artifact ID** against
   **pinned criteria**, not a moving branch or textual success claim.
6. On fail, inconclusive or error, preserve the verdict and evidence;
   classify the failure, propose a corrective Item or bounded retry,
   and start a new Attempt when justified. Do not retry unchanged blindly.
7. On pass, apply any required human QA and effect authorization.
   Reconcile remote effects before publishing or repeating them.
8. Feed QA defects and architectural findings back into the Work DAG,
   then recompute ready Items. A completed task is not a completed goal
   until the goal's acceptance contract is met.

This keeps the loop aligned with existing Work/Attempt/Artifact semantics.
Failure classification, retry policies and context selection need a
separate design review; they are not declared implemented by this note.

## Recommended follow-up research (reuse first)

| Priority | Research Work | Deliverable / decision gate |
|---|---|---|
| P0 | Inventory current Attempt startup, recovery, handoff and verifier input assembly | Evidence-backed gap map; do not duplicate existing code |
| P0 | Trace one real failed Work across retries and context resets | Repro, Artifacts, verdict links and any lost failure knowledge |
| P1 | Prototype bounded context rehydration as an adapter/view over existing records | No new persistence until a measured gap requires it |
| P1 | Test vertical-slice versus horizontal Item decomposition | Comparable end-to-end verification and conflict outcomes |
| P1 | Test independent fresh-context review versus same-session review | Exact-subject findings, false positives and missed defects |
| P2 | Audit deep-module boundaries and test seams in high-churn areas | Ranked opportunities backed by failures, not blanket refactoring |

Proposed measurements:

- **First-pass verification rate:** accepted on first eligible Attempt /
  Items with a first eligible Attempt.
- **Retry recovery rate:** failed Items later verified without changing
  their acceptance criteria / failed Items retried.
- **Repeated-failure rate:** repeated root-cause class after retry /
  retried Items with a classified earlier failure.
- **Time to first useful feedback:** duration from Attempt start to
  first actionable test or verifier evidence.
- **Reopen/regression rate:** previously verified Items later reopened
  due to QA or regression / verified Items observed.
- **Context and cost efficiency:** input tokens and runtime cost per
  **verified** Item, with scope and model tier recorded.
- **Evidence completeness:** eligible verdicts with subject, criteria,
  policy, provenance and accessible evidence / all eligible verdicts.

Compare matched tasks with fixed acceptance criteria and record complexity,
model, runtime, test coverage and token budget. A higher pass rate without
independent evidence or a higher cost must not automatically count as progress.

## Risks and non-goals

- **False-green feedback:** tests, type checks and self-review can pass
  despite broken deployment, migration or user behavior.
- **Missing context:** an over-aggressive reset can drop a negative
  decision, security constraint or unresolved dependency. Preserve
  decisions and evidence as durable, scoped inputs.
- **Stale evidence:** a verdict on an old commit/Artifact must not attest
  newer code. Use exact-subject verification.
- **Security:** Artifact identity does not grant access; context
  rehydration must honor classification and egress rules.
- **Unbounded retries and context inflation:** set stopping conditions
  and measure repeated failures. Do not paste complete histories by default.
- **Premature framework adoption:** do not add a Ralph engine, Sandcastle
  clone, new context database or forced skill naming. Reuse existing System
  contracts and external libraries only where they demonstrably fit.
- **Over-prescription:** TDD and vertical slicing are useful defaults,
  not rules for every research task, prototype or infrastructure change.

## Decision requested, not yet made

Approve a focused investigation of **fresh-context Attempt rehydration** and
failure-to-feedback continuity, with vertical-slice Work decomposition and
independent review as measured companion hypotheses. Keep this as research
until a design proposal is supported by actual System traces and tests.
