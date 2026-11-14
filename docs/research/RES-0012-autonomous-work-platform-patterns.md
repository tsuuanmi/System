---
id: RES-0012
type: research
status: active
summary: Compare durable autonomous coding services, agent coordination, feedback control, worker interoperability and governance patterns against System's existing contracts.
related: [ADR-0002, ADR-0007, ADR-0009, PROP-0008]
---

# Research: multi-project durable work and feedback patterns

**Investigated:** 2026-11-14. External references and observed System source
are evidence, **not normative requirements** or claims that the ideas below
are already implemented. Proposed product implications live in
[PROP-0008](../proposals/PROP-0008-system-across-projects-workers-and-time.md).

## Verified System baseline and constraints

- [System Product Charter](../requirements/purpose.md) defines a durable
  control plane, replaceable Worker runtimes, explicit authorization.
- [Host architecture](../architecture/host.md) and the source in
  packages/work, packages/host and packages/app already provide deterministic
  ownership, slots, restart recovery, effect/verification handling and a
  system mcp caller path; avoid a parallel state machine for these functions.
- [ADR-0009](../decisions/ADR-0009-goals-and-orchestrators.md) was superseded
  when prior Goals, decisions, briefs and the Orchestrator were removed.
  Durable high-level intent must be a **new proposal** with evidence it
  needs a runtime; a session caller remains a supported baseline.
- [Bootstrap guide](../governance/bootstrap.md) and
  [bootstrap_docs.py](../../tools/bootstrap_docs.py) already provide
  portable documentation scaffolding, create-only, and a level-1 checker.
  Full new-project onboarding and safe checks generation are missing from
  the existing documented script.
- A pool of 20 accounts/Workers is primarily a **cross-project capacity**
  question, not a demand to assign 20 agents to one repository.

## Research map (sources and extractable patterns)

| System | Source and directly supported feature | Study and adapt | Do not copy |
|---|---|---|---|
| OpenAI Symphony | [spec](https://github.com/openai/symphony/blob/main/SPEC.md), [README](https://github.com/openai/symphony): long-running service tracks issues, isolated workspaces, bounded dispatch, recovery and repo-owned workflow contract; reference implementation is experimental | Separate intent/issue readiness from transient agent sessions; observable dispatch, backoff, work eligibility | A second Host state machine or assumption that Linear is System's canonical store |
| Gas Town / Gas City / Beads | [author's project history](https://www.yegge.ai/gastown): Gas Town is retired; Gas City is its successor; Beads is a durable, versioned agent work ledger | Handoffs, dependency graph, agent/workspace hygiene, reusable coordinator parts, worker leases | Gas Town's entire command taxonomy, duplicated ledger or a second merge queue |
| Microsoft Magentic-One | [Microsoft Foundry Labs](https://labs.ai.azure.com/innovations/magentic-one/): Task Ledger + Progress Ledger, outer replanning loop and inner subtask-execution loop | Evidence-based progress checkpoints, structured diagnosis of stalled research, adaptation to new hypotheses | Treat a model's self-reported progress as verification |
| Temporal | [durable execution](https://docs.temporal.io/workflow-execution): stateful workflows with durable timers and signals | Pause/wake, bounded retry, recovery and compensation as testable contracts | Add Temporal as an engine without proving a gap in System's Host |
| Anthropic multi-agent research | [engineering account](https://www.anthropic.com/engineering/multi-agent-research-system): orchestrator/worker research parallelism, explicit division of work and substantial token costs | Three execution strategies and task-specific worker fan-out; measure outcomes and spend | Always use teams for sequential tasks |
| Agent Client Protocol (ACP) | [protocol overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx): JSON-RPC initialize, session/new, session/prompt, session/update, cancel and optional resume | Provider-neutral runtime adapter, session lifecycle, permission handling and capability negotiation; compare existing draft PRs #72/#73 | ACP sessions as new Work owners or implicit Host-authorized humans |
| OpenTelemetry | [trace specification](https://opentelemetry.io/docs/concepts/signals/traces/): spans, parent-child context and links | Correlate Goal, Work, Attempt, verifier, effect and notifications across sessions | Replace immutable Artifact/event ledger with mutable telemetry |
| Engineering feedback control | [feedback systems overview](https://www.mathworks.com/discovery/feedback-control.html): observe output against desired setpoint and adjust actions | Detect-observe-classify-decide-act-verify-learn, cooldown, saturation/anti-windup, stability and safe stopping | Unbounded self-correction that silently alters success criteria |

**Evidence quality:** links above identify primary project/standards sources,
not a reproducible head-to-head benchmark of System. No external architecture
has been proven superior to System for this workload.

## Proposed experiments and falsifiable success criteria

1. **Bootstrap:** compare a manual new-project setup against a scripted,
   create-only plan/apply/check flow. Cases: empty repo, partially documented
   repo, existing CI with required checks, offline or unavailable remote.
   Measure human steps, files overwritten (target zero), governance/CI checks,
   authorization and repeat execution.
2. **Coordinator vs caller:** a Claude Code or Codex session at Project A
   starts Work in Project B via system mcp; replace that session mid-program.
   Compare a session-driven sequence with an optional durable coordinator
   using the *same* Work store. If both meet reliability targets, keep the
   smaller solution.
3. **Worker fan-out:** one vs 4 vs 8 vs 20 available Workers across at least
   three Projects. Test independent, dependent and conflicting code changes.
   Measure p50/p95 wall time, queue wait, token demand, verified completion,
   false positive verdicts and integration conflicts; model headroom limits
   and account contention explicitly.
4. **Long-horizon Goal:** multi-day research -> implement -> benchmark loop.
   Kill the session, restart Host, swap provider, exhaust a quota, fail a
   check, observe ambiguous external effect; verify state continuity and
   bounded progress without duplicated effect.
5. **Failure feedback:** inject timeout, provider outage, no-progress loop,
   environment-dependent check, wrong verification, approval hold and
   blocked quota. Each case has explicit classification, bounded response,
   evidence and operator-visible terminal or held status.
6. **Evolution:** benchmark alternative Worker adapter/version on identical
   tasks, propose PR if better, canary under policy, verify/rollback. Never
   promote from the same model's unsupported quality assertion.

## Engineering/mechatronics feedback analogy

Closed-loop control is useful as a design analogy, not a literal PID loop for
software. Map **reference** to operator-approved acceptance, **plant** to Work
execution, **sensors** to independent checks/telemetry, **controller** to
deterministic policy plus a replaceable reasoning caller, **actuator** to
retry/re-route/propose new Work, **error** to measured outcome deviation and
**stability** to bounded safe convergence. Treat delays, noisy observations,
rate limits, correlated failures and measurement gaming as real hazards.

A complete Feedback Loop is **detect -> observe -> classify -> decide ->
act -> verify -> learn**, including *capability evolution*. A retry without
independent remeasurement is **open-loop repetition**, not evidence of learning.

## Open questions to resolve before promoting a proposal

- Is Goal an Artifact-only immutable program record, derived view over
  existing Works, or a minimal separate coordinator-owned durable record?
  What exact user need justifies it after the earlier removal?
- What must System own versus what can remain in an operator's Claude/Codex
  session? Which user-facing functionality is mandatory under a hard restart?
- What is the minimum safe Host-side authority model for bootstrap, forced
  work actions, acceptance and unattended release update?
- What should happen if a Program needs a long wait, exceeds quota, stops
  improving or changes its own benchmark?
- How are worker/model choices calibrated when cached input, subscriptions
  and API rates are not directly comparable?
- How are multiple projects budgeted fairly without starving a high-priority
  job or creating worker-to-worker communication overhead?

**Recommended decision discipline:** write hypotheses, run small experiments
against System's existing mechanisms, retain measurements as Artifacts,
choose the smallest viable extension, then promote the accepted outcome into
the authoritative requirement/architecture docs and an ADR.
