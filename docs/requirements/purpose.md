---
type: requirement
status: active
reviewed: 2026-11-21
related: [architecture/control-plane]
---

# System Product Charter

## Identity

**System is the gate and the ledger for the work one operator delegates to AI Workers.**
A result (a change merged into a repository, or a stored report) is accepted
only by the Verifier pinned for it, and everything a new session or Worker
needs to carry on is a record. It is not an agent loop: Workers do the work,
each in the Role it fits.

**Tagline:** Work persists. Workers change. Humans govern.

System works for one **operator** (GLOSSARY Operator) across several
repositories and possibly several machines. Other people or a team are a
non-goal until a second operator exists. Installing System on a new machine
(clone, then follow one guide or run one script) is a requirement, not a
nicety.

This is **the current product intent**, not a claim that the product has been
implemented. System is a control plane hosted on DSH: the control-plane decision and selected DSH host are recorded in
[ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md).

## Mission

System turns the operator's Intents (what they want done, in plain prose) into
results (verified changes in their repositories, verified research reports)
with as little of the operator's attention as possible. Durable Work, Artifacts
and Verdicts are how; P1 to P3 below are the constraints that hold while it
does so. The supply of Items is part of that attention: turning a product's
evidence into a Batch the operator accepts in one act is done by a caller's
Workflows and the product repository's checks, outside the Host (ADR-0012: the
Host never picks).

## Headline measure

**Verified Items merged per operator act**, read from the Host's records and
repositories by `system work report`, not by hand. Verified Success Rate,
Recurring Failure Rate, Escaped Defect Rate, Cost per Verified Work and Time to
Verified Resolution are diagnostics. `work report --since` computes the headline
measure (`headline`): distinct Items merged, the operator acts in the range
(`parts`, and `operatorActs`, their sum) and their ratio (`itemsPerAct`, `no
acts` when there are none). An operator act is:

- an `intent@1` the operator settled (`settledBy: operator`, set by `system
  intent new --settled-by-operator` or the MCP `settledByOperator`, only when the
  operator said so in that session; an Intent without it is not counted);
- a `confirmation@1` the operator stored for an Artifact they confirmed, such as
  a dataset or a set of labels (`system confirm`, MCP `artifact.confirm`);
- a release: a merge of `dev` into `main` seen in the repository (a first-parent
  merge of `main` that merges `dev`), for each repository the Host knows Items for;
- a human touch, as `summary.ts` counts them (human callers only).

Conversation with a caller session is not seen by System: only what the caller
records (the flag and the confirmation) is counted, so an unrecorded decision is
not an act. Say it was the operator's only when it was.

## Vision

A person delegates an outcome, not a sequence of tool commands. A change of
Provider or Worker does not lose a Work, its artifacts, history or acceptance
criteria, and each Role is held by the Provider that fits it. The person retains control of material risks
and decisions, instead of becoming a bottleneck for routine operations.

## Fundamental purposes

**P1 — Work continuity.** Work and essential artifacts outlive a Worker
session, process restart and provider change. A failed Worker must not erase
the identity of the task or force unsafe effect replay.

**P2 — Workflow generality.** The core stays the same; what differs with the
nature of the work is the Workflow, the Role and the Verifier. A kind of work
enters System when its result has a Verifier and a place to live (a merged
change or a stored report). **Software Engineering** and **Research** are the
two kinds demonstrated, not just different coding templates.

**P3 — Bounded autonomy.** Authorized routine work advances without an
approval for every command; privileged or uncertain effects are subject to
explicit policy and operator authority. Autonomy is never permission to
evade policy.

## Philosophy

1. **Work-first, not agent-first:** work and its outcomes are the domain model;
   a change of Provider or Worker does not lose a Work, and each Role is held by the Provider that fits it.
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
8. **Reuse standards and DSH before building:** DSH/Cordis is the chosen host
   and composition foundation. Reuse its mechanisms and community ecosystem,
   and established standards (git, JSON Schema, MCP, systemd), before
   inventing anything. What System records is deterministic, artifact-based
   and explainable by logic: a new format or mechanism names the standard it
   considered first.
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
   or paid for by removal (a trend, not a gate: ADR-0015), and every milestone ends with a pass that proposes
   deletions and simplifications.
12. **Fast, accurate, testable feedback loops:** a change is checked quickly
   and exactly enough to iterate many times. The required checks stay within
   their time budget, every behavior has a test that can fail, and a flaky
   test is a defect fixed before new features.

## Success means

Each criterion names the test that pins it today (`file`: "test name").

- **Work continuity:** a Work survives a killed Host and a Workflow file edit;
  done steps never re-run. `tests/work.test.ts`: "the pinned spec survives a
  Workflow file edit and a killed host; done steps never re-run".
- **Workers change without losing Work:** the controller and Workflow compiler name no domain,
  Worker or verifier; a retry hands a cancelled attempt's partial output on.
  `packages/work/tests/controller.test.ts`: "the controller and Workflow
  compiler name no domain, Worker or verifier"; "a cancel during an attempt
  keeps its partial output, and retry hands it on as previous".
- **Effect integrity:** an effect records intent before and outcome after; an
  unknown outcome is reconciled or held, never blindly retried.
  `packages/work/tests/effects.test.ts`: "a host lost after the remote applied
  the effect but before it was recorded: reconcile records it, nothing is
  applied again"; "an outcome reconciliation cannot establish holds the Work
  and applies nothing"; `tests/publish-crash.test.ts`: all three crash points.
- **Authority:** only a human at a terminal approves; a denial fails the Work.
  `tests/publish-approval.test.ts`: "marking the pull request ready waits for a
  human at a terminal; an agent or a pipe cannot approve".
  `packages/agents/tests/runtimes.test.ts`: "an attempt's git over ssh is refused by GIT_SSH_COMMAND, without a
  network" (a Guardrail against accident, not a sandbox: an agent that unsets the variable gets past it). Egress limits:
  not pinned.
- **Exact-subject verification:** a verdict about another subject, other
  criteria or without evidence is never a pass; a changed subject voids the old
  verdict. `packages/work/tests/controller.test.ts`: "a verdict about another
  subject, other criteria, or without stored evidence is an error, never a
  pass"; "retry --step after failed checks reruns the Worker and re-verifies the
  new subject; the old verdict never counts".
- **Two domains, one core:** Software Engineering and Research reach verified
  outcomes through the same controller, with a code-tree checker and a
  citation checker. `tests/work.test.ts`: "a direct Task, Software Engineering
  and Research all succeed through one controller"; `tests/verify.test.ts`:
  "Research: cited quotes found at their URLs pass, through the same
  controller".
- **Config-defined workflows:** invalid Workflows (duplicates, cycles, missing
  outputs, unavailable capabilities) are refused before any Worker runs, and
  the admitted spec is pinned. `packages/work/tests/workflow.test.ts`: "cycles
  are refused with their path"; "capabilities no enabled Worker or verifier
  provides are refused before any Worker runs"; `tests/work.test.ts`: "an
  invalid Workflow is refused before any Worker runs, and no Work is created".
- **Artifact handoff:** an attempt keeps the Artifacts it reports and replay
  matches. `packages/work/tests/controller.test.ts`: "a succeeded attempt keeps
  the Artifacts it reports beside its outputs, and replay matches".
- **Optional plugins stay optional:** a disabled row is unavailable without
  breaking the rest. `tests/web-worker-off.test.ts`: "the web-worker row is off
  in the bundle". Disabling a plugin with in-flight work: not pinned.
- **Accounting and operator touches:** usage the Worker does not report is
  unknown, never zero; decisions, retries and cancels count as touches.
  `packages/work/tests/controller.test.ts`: "usage a Worker does not report is
  recorded as unknown, never zero"; `packages/work/tests/summary.test.ts`:
  "human decisions, retries and cancels are touches; unknown usage is counted
  apart, never as zero". Comparing usage with an oracle: not pinned.

External reference targets R1–R5 are recorded in
RES-0001 (retired; [ledger](../governance/retired.md)); they are **not** shipped
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
- A planner inside the Host.
- A model that accepts a result.
- Owning a product's evaluation set, error budget or release.

## Product / implementation separation

Product purpose is independent of a particular Worker and workflow. Hosting
is **not** undecided: DSH/Cordis is selected for execution/plugin composition
([ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md)).
System-specific work contracts should not expose DSH-internal event types
at their public boundary where a narrow adapter will suffice. Additional
accepted decisions: [Workflow as configuration](../decisions/ADR-0002-work-primitive-configured-workflows.md)
and [artifact/verification contracts](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md).
