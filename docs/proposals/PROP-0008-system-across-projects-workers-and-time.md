---
id: PROP-0008
type: proposal
status: proposed
created: 2026-11-14
summary: Explore project bootstrap, durable multi-project Goals, adaptive independent and team execution, feedback control and replaceable session callers without adding a second Work engine.
related: [ADR-0001, ADR-0002, ADR-0003, ADR-0007, ADR-0008, ADR-0009]
evidence: [RES-0012]
---

# Proposal: System across projects, workers and time

**Status:** operator-directed product brainstorm on 2026-11-14, not an implementation
claim or permission to merge. Existing facts belong to the source and canonical
documents; external findings belong to [RES-0012](../research/RES-0012-autonomous-work-platform-patterns.md).
The [Product Charter](../requirements/purpose.md) remains authoritative until
an explicit decision promotes any of the proposals here.

## Product intent

> System transforms user intent into durable, coordinated, verified outcomes —
> across workers, projects, and time.

Keep **Work persists. Workers change. Humans govern.** A Claude Code or Codex
session, from the System checkout or any other project's session, is a
replaceable **caller** through the same System CLI/MCP Host. The caller is
neither the Work owner nor an approval authority. System, rather than a
particular session's context, owns continuity, verification, results and
reconciliation.

Success is measured by **verified outcomes per unit of cost and human
attention**, not number of active agents, tokens spent or apparent activity.

## What is actually present today (read on dev at b789061, 2026-11-14)

- One long-running DSH/Cordis Host and deterministic Work Controller, with
  commit lane, routing by Account headroom/slots, persisted events, Artifact
  IDs, verification, effect reconciliation and restart handling; see
  [Host](../architecture/host.md) and
  [Work ownership](../architecture/work-ownership-and-recovery.md).
- Short Workflows (develop, hygiene, research, brainstorm), scoped retries,
  terminal/satisfied outcomes, CLI and stdio MCP for sessions from other
  checkouts; the scheduled Claude session is a caller launched by a
  systemd timer, not a new Work engine.
- The existing [documentation bootstrap guide](../governance/bootstrap.md)
  and [create-only script](../../tools/bootstrap_docs.py) copy the portable
  standard, Level-1 checker, target-specific profile, routers, AGENTS.md and
  docs CI into another repository without overwriting files.
- The current MCP instructions still ask a new repository's session to
  bootstrap manually. A single System command does **not** yet do full
  repository onboarding, configure checks, or activate a project.
- **Brain distinction:** System already has a deterministic execution/control
  brain (dispatch, retry, recovery, evidence and effect decisions), and human
  or Claude/Codex sessions can perform planning. It does **not** have a
  permanently running, provider-independent strategic planning brain that
  autonomously decomposes, re-plans and budgets long-horizon multi-project
  Goals. Treat that as a proposed optional coordinator, not a shipped feature.
- [ADR-0009](../decisions/ADR-0009-goals-and-orchestrators.md) explicitly
  superseded the former Goal/Orchestrator machinery in DF2. Do not revive
  that old goal@1 and its controller branches merely by renaming them.
- A Host/code upgrade is supported by the existing operator-run system
  update path; *unattended autonomous software update* is not an existing
  blanket privilege.

## 1. First-class adoption: propose system bootstrap

Problem: today the operator has to share
[the documentation architecture standard](../governance/documentation-architecture.md)
with a fresh coding session, then teach it how to prepare that repository.
The portable skeleton exists; discovery, safe checks configuration and
enrollment are fragmented.

Proposed UX, **illustrative only**:

    system bootstrap --repo /path/to/new-repo --name "New Project"
    system bootstrap --repo /path/to/new-repo --apply
    system bootstrap --repo /path/to/new-repo --check

- A no-write **plan** is default. Report git remote, branch topology,
  current documentation, CI/checks, missing files, potential conflicts,
  permissions, and exactly what apply will change. Unknown inputs result
  in actionable questions, not invented configuration.
- The apply path **reuses** tools/bootstrap_docs.py create-only output,
  copies the portable documentation standard from the installed System
  release, and adapts only target-local metadata. It does not copy System
  product requirements, ADRs, workflows or history wholesale.
- Inspect existing project build/CI and **propose** .system/checks.yaml,
  preserving actual required gates. Validate its commands; never fabricate
  tests, silently weaken checks, or create a false green verifier.
- Do not silently create dev, commit, push, change branch protection,
  install credentials or start unattended work. Such effects require
  separate explicitly authorized steps and normal Git permissions.
- Existing targets must be idempotent, conflict-aware, resumable, create-only
  by default, and offer dry-run/diff. A failure leaves an inspectable plan.
- Provide an MCP-accessible **read-only bootstrap plan** to callers where
  useful; a session may request setup, but privileged apply still crosses
  an explicit Host-enforced human-policy boundary.
- Clarify the difference between **system init** (install/profile/Host)
  and **system bootstrap** (adopt a target project). Validate that both
  Claude Code and Codex sessions can discover and use System from other
  repositories without a separate System Host.

**Acceptance:** a clean demo repo, a repo with existing governance, and a repo
with existing CI can be bootstrapped twice without clobbering files; generated
docs check/sync pass; invalid or unknown checks are surfaced; no unapproved
remote branch or commit is produced. Add real Host/MCP negative authorization
tests, not prompt-only restrictions.

## 2. Three execution modes, not twenty agents for every project

1. **Independent Workers**: independent tasks or projects; workspaces and
   Artifacts isolated; no costly cross-agent conversation.
2. **Coordinated Team**: a bounded set of related Work with dependency graph,
   integration/merge ownership, explicit handoffs and limited team coordinator.
   Avoid concurrent edits to the same shared tree without isolation.
3. **Specialist Review Team**: independent research/design/review attempts,
   then synthesis, disagreement accounting and a verifier; preserve independent
   evidence instead of letting a lead's summary replace it.

These are strategies chosen **per objective or subtask**, not hardcoded
Worker roles, new Work states or one mandatory team hierarchy. The default
is a single Worker when it is sufficient. A pool of twenty available Workers
may be spread among System, DNA, Creator and PageFleet according to readiness,
priority, quota, dependency and load. **20 is a concurrency evaluation target,
not a required per-project allocation.** Fairness, per-project limits and
integration contention matter as much as raw throughput.

## 3. Long-running Goal composed of multiple short Works

**Proposal only:** a Goal (or Program) is a durable high-level intent spanning
days/weeks, optionally several Projects, with purpose, constraints, budgets,
success tests, pause/review rules and history of evidence-backed iterations.
It **contains/references multiple Works**. A Work remains the bounded,
verifiable execution unit; no Agent session must live for days.

Illustrative loop: research -> hypothesis -> implement -> independent test ->
compare with baseline -> decide continue/stop/re-plan -> next Work.
Every iteration records its Task, inputs, code/change, criteria, verdict,
benchmarks and decision evidence by Artifact ID. Stop on success, bounded
failure, no meaningful progress, budget exhaustion or a human gate.

The proposed Goal/Program coordinator stays **above** the existing Host;
it submits ordinary Works and reads existing events. It must not own a
second mutable Work state, a second effect engine or private model loop.
First prove that a replaceable Claude/Codex caller plus persisted program
records can meet the requirement; only add a durable coordinator plugin
when measurements show the caller-driven approach is insufficient.

## 4. Background service and the right kind of brain

- **Execution brain (shipped):** deterministic Host scheduler, policy
  enforcement, retries, reconciliation, Artifact-based evidence and effects.
- **Planning brain (proposed):** a replaceable caller/coordinator that picks
  work, tracks program progress, chooses execution strategy and requests
  specialized reasoning through Workers. Planning is a capability, not
  authority to approve, self-modify policies or promote a release.
- Keep System as a systemd-supervised background service, with scheduled or
  event-driven **callers**, not twenty always-running LLM loops. Waiting
  should not consume model tokens. Recovery and notifications must survive
  caller/session replacement.
- Detect stalls, outside failures, quota gaps and lost/unknown effects,
  classify cause, apply bounded prescribed remedies, expose when work is
  held and why. Never silently claim success or retry an unknown effect.
- **Self-update is separate from self-healing:** System may propose a tested
  update/rollback with exact release evidence; unattended system update is
  opt-in policy requiring provenance, verification, rollout/rollback gates,
  and an authority boundary. Default remains operator-controlled promotion
  to main and release. Do not let a failing Worker rewrite its own verifier
  or install arbitrary code to clear a failure.

## 5. Feedback Loop, borrowing from engineering/mechatronics

Use **Feedback Loop** as the umbrella, including capability evolution. The
analogy is a closed-loop controller: desired outcome (setpoint), observations
(sensor), deviation/error, diagnosis/controller, bounded corrective action
(actuator), and measurement of the **next real outcome**.

For System:
**detect -> observe -> classify -> decide -> act -> verify -> learn**.

Inputs include Work events, checks, external effects, benchmark results,
resource load, quota and human decisions. Outputs are bounded automatic
retry/re-route, a new approved Work, a hold/alert or a proposed improvement.
Learning means evidence-backed regression candidates, new tests or a reviewable
PR, **not** silently modifying its own authority or acceptance criteria.

Adopt control-system safeguards: hysteresis/cooldown against oscillation,
anti-windup (no unbounded retry/backlog when rate-limited), explicit stop
conditions, safe degraded modes and traceable intervention. Validate that
correction improves an external signal rather than gaming its own verifier.

## 6. Efficiency, context and attention

- **Adaptive model selection:** choose Worker/model tiers using capability,
  task risk, measured success, latency, quota and total resource cost. Upgrade
  only when evidence supports it; record actual provider/model and unknown
  billing rather than assume equivalence across subscriptions and API prices.
- **Context engineering:** hand off Task + minimum relevant Artifact IDs,
  previous failed verdict/evidence and accepted decisions. Keep large logs and
  full chat transcripts out of new model contexts unless requested. Preserve
  provenance and exact byte-level evidence for replay.
- **Attention-aware reporting:** one consolidated project/Goal status and
  daily/exception digest showing verified outcomes, blocked decisions,
  budgets and links to evidence. Only interrupt the human for real decisions,
  expiry, safety limits or substantive completion; do not send twenty
  independent Worker progress pings.

Suggested evaluation: verified-outcome rate, time to verified result (p50/p95),
tokens and **actual vs API-equivalent** costs, wait time, attempts/rework,
human interventions, regression rate, false-success rate and operator minutes
per completed outcome. Benchmark single/4/8/20 Workers **across Projects**,
including sequential and parallel workloads; more agents must be allowed to
lose against a simpler strategy.

## 7. Research, boundaries and proposed delivery

[RES-0012](../research/RES-0012-autonomous-work-platform-patterns.md)
records source-level research on Symphony, Gas City (successor to retired
Gas Town), Beads, Magentic-One, Temporal, Anthropic's research agents and
ACP. Reuse only the useful invariant or pattern at an existing System seam.
Do not vendor an orchestration framework, duplicate DSH, add model-specific
branches to Work or assume multi-agent beats single-agent.

Possible **sequenced experiments**, not authorized implementation Items:

1. **Bootstrap MVP:** plan / apply / check, reuse existing scaffold, test
   on three target repository shapes and through other project sessions.
2. **Multi-project visibility:** status of several repositories from one
   CLI/MCP caller, bounded priorities/quotas; no new Work state.
3. **Long-horizon proof:** one multi-day research/implement/test Program
   through replaceable sessions, with explicit stop and restart tests.
4. **Adaptive teams:** compare the three modes and the one-Worker baseline
   under shared load; observe merge conflicts, tokens and outcomes.
5. **Feedback and capability evolution:** failure taxonomy, remediation
   outcomes, regression candidate, candidate Worker/SDK benchmark and
   operator-gated promotion/rollback.

**Acceptance gates before any implementation PR:** preserve Work/Attempt/
Artifact/Verifier/Effect semantics, capability-based routing and
human-governed decisions; preserve compatibility for other-project callers;
negative tests for agent privilege boundaries; fault-injection and effect
idempotency; budget and simplification pass; an explicit operator decision
to promote proposed contracts to authoritative requirements/architecture.

**Documentation budget:** this is a requested research/proposal spike and
temporarily adds documentation above the last reported docs line budget.
Do not silently reset the budget; measure the increase, remove duplicate
material at implementation time, and seek an explicit budget exception or
simplification decision before treating the milestone as closed.
