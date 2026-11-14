---
id: RES-0012
type: research
status: active
summary: Compare Markdown-first work decomposition, durable agent runtime supervision, remote machines, feedback and multi-project dispatch against existing System contracts.
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
  Long-term intent can remain in repository Markdown (or a small optional
  index); a new Goal runtime is **not** presumed necessary. A session caller
  remains the baseline, with durable Item/Work state and optional dispatcher.
- [Bootstrap guide](../governance/bootstrap.md) and
  [bootstrap_docs.py](../../tools/bootstrap_docs.py) already provide
  portable documentation scaffolding, create-only, and a level-1 checker.
  Full new-project onboarding and safe checks generation are missing from
  the existing documented script. `packages/work/src/status.ts` already
  derives Item state from `STATUS.md` and Work records rather than relying
  on agents ticking completion checkboxes.
- A pool of 20 accounts/Workers is primarily a **cross-project capacity**
  question, not a demand to assign 20 agents to one repository.

## Research map (sources and extractable patterns)

| System | Source and directly supported feature | Study and adapt | Do not copy |
|---|---|---|---|
| OpenAI Symphony | [spec](https://github.com/openai/symphony/blob/main/SPEC.md), [README](https://github.com/openai/symphony): long-running service tracks issues, isolated workspaces, bounded dispatch, recovery and repo-owned workflow contract; reference implementation is experimental | Separate intent/issue readiness from transient agent sessions; observable dispatch, backoff, work eligibility | A second Host state machine or assumption that Linear is System's canonical store |
| Gas Town / Gas City / Beads | [author's project history](https://www.yegge.ai/gastown): Gas Town is retired; Gas City is its successor; Beads is a durable, versioned agent work ledger | Handoffs, dependency graph, agent/workspace hygiene, reusable coordinator parts, worker leases | Gas Town's entire command taxonomy, duplicated ledger or a second merge queue |
| Herdr | [README](https://github.com/herdrdev/herdr), [agent automation](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/agent-automation.mdx): session/workspace/tab/pane hierarchy; agent start/prompt/read/wait; working/blocked/idle/done state; remote machines and reconnect | Operator visibility of multiple agent terminals, bounded cross-agent interactions, optional remote runtime transport | Treat pane state or printed output as a verified System outcome; duplicate Work/Artifact storage |
| Herdr Core (`hc`) | [README](https://github.com/herdrdev/herdr-core/blob/master/README.md), [templates](https://github.com/herdrdev/herdr-core/blob/master/docs/templates.md), [security](https://github.com/herdrdev/herdr-core/blob/master/docs/security.md): headless run/send/read/wait, child-parent lifecycle, named templates, SSH machines, `hc connect` and schema | Possible optional terminal lifecycle backend for WorkerPort or ACP, with remote health monitoring and human takeover | Host-level unverified authority, parallel retries of an unknown-running remote process or assuming a terminal survived a machine restart |
| Microsoft Magentic-One | [Microsoft Foundry Labs](https://labs.ai.azure.com/innovations/magentic-one/): Task Ledger + Progress Ledger, outer replanning loop and inner subtask-execution loop | Evidence-based progress checkpoints, structured diagnosis of stalled research, adaptation to new hypotheses | Treat a model's self-reported progress as verification |
| Temporal | [durable execution](https://docs.temporal.io/workflow-execution): stateful workflows with durable timers and signals | Pause/wake, bounded retry, recovery and compensation as testable contracts | Add Temporal as an engine without proving a gap in System's Host |
| Anthropic multi-agent research | [engineering account](https://www.anthropic.com/engineering/multi-agent-research-system): orchestrator/worker research parallelism, explicit division of work and substantial token costs | Three execution strategies and task-specific worker fan-out; measure outcomes and spend | Always use teams for sequential tasks |
| Agent Client Protocol (ACP) | [protocol overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx): JSON-RPC initialize, session/new, session/prompt, session/update, cancel and optional resume | Provider-neutral runtime adapter, session lifecycle, permission handling and capability negotiation; compare existing draft PRs #72/#73 | ACP sessions as new Work owners or implicit Host-authorized humans |
| OpenTelemetry | [trace specification](https://opentelemetry.io/docs/concepts/signals/traces/): spans, parent-child context and links | Correlate Goal, Work, Attempt, verifier, effect and notifications across sessions | Replace immutable Artifact/event ledger with mutable telemetry |
| Engineering feedback control | [feedback systems overview](https://www.mathworks.com/discovery/feedback-control.html): observe output against desired setpoint and adjust actions | Detect-observe-classify-decide-act-verify-learn, cooldown, saturation/anti-windup, stability and safe stopping | Unbounded self-correction that silently alters success criteria |

**Evidence quality:** links above identify primary project/standards sources,
not a reproducible head-to-head benchmark of System. No external architecture
has been proven superior to System for this workload.


## Deep dive: Herdr as a remote agent runtime, not a Work brain

**Sources inspected 2026-11-14:** upstream
[herdr README](https://github.com/herdrdev/herdr/blob/master/README.md),
[agent-automation docs](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/agent-automation.mdx)
and [herdr-core README](https://github.com/herdrdev/herdr-core/blob/master/README.md).
These are two related but **distinct** surfaces: Herdr is a terminal UI and
agent-aware multiplexer; **herdr-core (\`hc\`) is headless** and has its own
terminal, agent, machine and API primitives. Do not conflate commands.

- **Organize:** Herdr maps workspace -> tab -> pane -> agent. It
  differentiates terminal location from the currently detected Agent process.
  System maps project -> Item -> Work -> Attempt and stores verified evidence.
  These are complementary, **not interchangeable hierarchies**.
- **Supervise:** Herdr starts supported agents in existing panes, prompts,
  reads, inspects and waits for \`working\`, \`blocked\`, \`idle\`,
  \`done\` or \`unknown\`. \`done\` is **terminal agent activity**, not
  proof of accepted work; \`blocked\` may mean an interactive question.
  The state may be inferred from screen/UI and needs validation.
- **Remote:** Herdr combines local and saved SSH machines in one viewer and
  reconnects independently. Herdr Core runs programs **on** named remote
  machines, keeps their files there and exposes \`hc connect\` / machine
  commands. Local references must identify their machine to avoid collisions.
- **Agent-to-agent:** Herdr can start/prompt another agent and wait on
  lifecycle; Herdr Core supports nested child processes, parent notes,
  messages and templates (\`hc run --bg\`, \`hc send\`, \`hc wait --children\`).
  This is a useful **transport/process mechanism** for an audit team, not
  automatic decomposition, independent verification or policy enforcement.
- **Recovery:** detaching the client does not terminate an active process.
  A machine restart cannot preserve the original process; Herdr may restore
  layout/session and resume supported agents, while Core can restore a kept
  shell but does **not** blindly rerun a lost task. Distinguish this from
  System recovering a durable Work and deciding if a replacement Attempt
  is safe.
- **Security:** study remote trust, credentials, signed binaries, process
  ownership, visibility and isolation in Herdr Core's
  [security documentation](https://github.com/herdrdev/herdr-core/blob/master/docs/security.md).
  No claim that Herdr supplies all isolation/authorization System needs.

**Recommended evaluation:** run one read-only review Work through existing
local WorkerPort; compare an optional Herdr/core-managed Attempt across SSH
under the **same** pinned Task and Verifier. Fault-inject SSH drop, client
detach, remote reboot, blocked prompt, duplicated command and Host restart.
Require: one authoritative Work, exact Artifact evidence, safe cancellation,
explicit \`remote_unknown\` vs \`failed\` distinction and no duplicate
side-effect. Measure tokens, latency and maintenance overhead before accepting
an adapter. Test feature availability against the pinned upstream version.

## Read-only parallel audit experiment for System components

A long-lived agent team is not required to review System's components.
Use five **independent, read-only subagent Work/Attempt reviews**, scoped to
(a) Work/Item/Controller, (b) Host/MCP/authorization, (c) Worker/remote
runtime/account quota, (d) Artifact/verifier/effect/publish, and
(e) bootstrap/CI/operations/user-facing status. Give each a short inventory
of source paths, governing docs and tests; prevent repo writes and network
side effects. The caller may be Claude Code or Codex from any repository.

Output per reviewer: a structured Audit Artifact containing exact file/line
evidence, severity, tested/untested distinction, minimal recommendation,
confidence, and what already works. Run an **independent synthesis** to
deduplicate and compare findings, then a separate verifier to inspect
assertions before converting accepted findings to Items. Cross-check the
interfaces (e.g. \`caller\` trust boundary vs \`agent: true\` operation rows,
quota route vs slot ownership, unknown effect reconciliation vs remote
retries). In particular, remote terminal \`done\` alone must never resolve
a failed or incomplete System Work.

This is a documented experimental protocol, **not a claim of a completed
five-agent audit**. If the system running this PR review cannot spawn local
agents on the operator's machine, keep it a ready-to-execute audit plan.

## Proposed experiments and falsifiable success criteria

1. **Bootstrap:** compare a manual new-project setup against a scripted,
   create-only plan/apply/check flow. Cases: empty repo, partially documented
   repo, existing CI with required checks, offline or unavailable remote.
   Measure human steps, files overwritten (target zero), governance/CI checks,
   authorization and repeat execution.
2. **Markdown decomposition and dispatch:** a Claude Code or Codex session
   at Project A produces small Items from a repository ROADMAP/PLAN and
   submits ordinary Works for Project B via system mcp. End the session;
   use a minimal idempotent dispatcher to pick up eligible Items across
   restarts. Only compare a heavier coordinator when the simple case fails.
3. **Worker fan-out:** one vs 4 vs 8 vs 20 available Workers across at least
   three Projects. Test independent, dependent and conflicting code changes.
   Measure p50/p95 wall time, queue wait, token demand, verified completion,
   false positive verdicts and integration conflicts; model headroom limits
   and account contention explicitly.
4. **Long-horizon Item backlog:** a ROADMAP.md or PLAN.md plus STATUS.md
   provides a multi-day research -> implement -> benchmark sequence.
   Kill the caller session, restart Host, swap provider, exhaust quota,
   fail a check, and observe ambiguous effect; verify state continuity,
   bounded progress and no duplicate effects without a Goal runtime.
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

- Can repo-local Markdown plus derived Item/Work evidence satisfy the
  operator's planning and audit needs? Which specific readiness or concurrent
  editing query would justify adding an index/database?
- What is the smallest background dispatch mechanism that resumes a finite
  ready-Item backlog after a Claude/Codex caller and Host restart, while
  keeping decomposition in existing agents and policy in Host?
- Would a Herdr/Core remote-runner adapter improve lifecycle visibility or
  multi-machine capacity enough to justify an extra dependency and remote
  credentials? Can it provide evidence beyond terminal state?
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
