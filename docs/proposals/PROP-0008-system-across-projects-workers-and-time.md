---
id: PROP-0008
type: proposal
status: proposed
created: 2026-11-14
summary: Explore project bootstrap, durable markdown-first plans decomposed into small Works, cross-project workers, remote agent runtimes and bounded feedback without a second Work engine.
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
  or Claude/Codex sessions can perform planning. It does **not** yet guarantee unattended long-horizon *item decomposition,
  ready-item pickup and forward progress* across interrupted agent sessions.
  This is primarily a scheduling/handoff problem, not proof that System needs
  a new strategic LLM brain or Goal state machine.
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

## 3. Long-term delivery through Markdown-first decomposition

**Operator clarification (2026-11-14):** a Goal, ROADMAP, PLAN or TODO **does
not require a new first-class System runtime primitive**. A Markdown file in
the target repository is sufficient initially; a small database or derived
index is an optional implementation choice only if Markdown causes proven
coordination or query problems. Avoid double-maintaining mutable truth in both
files and the Host. Existing \`STATUS.md\` already supplies Item intake and
derived done/doing/todo using Work records; extend that contract as narrowly
as measurements require.

**The hard problem is decomposition and sustained delivery**: use the agents
already available to turn high-level human requests into *small, testable,
independently executable* Items, then run them as ordinary Works, with evidence
and continuation after a caller session ends. An Agent may research, draft
and revise ROADMAP/PLAN/TODO files using a normal reviewed Work. System should
not implement a special long-horizon planner model or an alternate Work
orchestrator by default.

Suggested hierarchy is **a documentation convention, not a database schema**:

    GOAL.md / ROADMAP.md / PLAN.md / TODO.md (optional; repo-local)
      -> ready actionable Items (STATUS.md or linked tracker)
         -> Work (pinned Task + Workflow)
            -> Attempt / Artifact / Verdict / Effect

### How to decompose into good Items

Each Item should have: a clear expected outcome, known repository, small
owned scope, testable acceptance criteria, required inputs/dependencies,
link to parent plan or research, expected output Artifact, and a stop/hold
condition. Prefer a change that can be reviewed and verified in one Work.
Do **not** prescribe a token-based size threshold as proof of atomicity.
If an Item is uncertain, create a bounded research/prototype Item first.

A replaceable Claude Code/Codex session may decompose and revise a plan. Its
outputs are *proposals* until recorded and accepted under repository policy.
Do not let an agent mark its own Work done; verification and integration
remain authoritative. For dependency tracking, prefer references in Markdown
or existing GitHub Issues, and derive readiness from completed Work evidence;
introduce a DB only when dependency scans, concurrent planning or reliable
queries justify it.

### Long-term mechanism: dispatch + resume, not one long Agent session

A small **background dispatcher** (proposed) periodically or event-driven:
1. Reads project Item/plan state and existing Host Work outcomes.
2. Finds eligible Items with satisfied dependencies, no active Work, known
   checks and allowed budget/concurrency.
3. Dispatches one bounded Work (or asks a replaceable caller to decompose an
   oversize/ambiguous Item); records linkage to its origin.
4. Reacts to completion/hold/failure; runs bounded retry only under existing
   Workflow policy; prepares the next ready Item.
5. Reports unresolved questions to the human, rather than fabricating the
   next objective or changing the success criterion.

The dispatcher must be **idempotent** across crash/restart, use existing Item
claims and Host receipts, and never duplicate a running Work. A failed
decomposition should produce a question or a bounded research Work, not an
infinite self-replanning loop. With independent tasks, a Work queue can
progress across several repositories; each Project retains its own policy.

**Success demonstration:** hand System a documented multi-day target and a
finite Item backlog; shut down the initiating Claude/Codex session; restart
the Host once; run independent Items across two repositories; verify that
ready Work continues without duplicate effects and no extra Goal engine,
and that blocked decisions reach a user-facing report.

## 4. Background service, agents and the real coordination need

- **Existing execution brain:** Host is already deterministic and durable,
  with scheduling, retries, verification, event/Artifact ownership, and
  one source of truth for Work. Do not replace it with another agent.
- **Agent intelligence is sufficient as a starting assumption:** leverage
  Claude Code and Codex to inspect Plans, decompose Items, investigate
  failures and revise task descriptions. Avoid an additional resident
  "planning brain" until controlled experiments show it is necessary.
- **Missing glue:** ready-item eligibility, safe autonomous **dispatch**,
  cross-Project priority/fairness, linkage from plans to Items to Work,
  concise state handoff, and notifications when attention is required.
- Keep System as a systemd-supervised background service, with scheduled or
  event-driven lightweight dispatch, not twenty always-running LLM loops.
  Waiting should not consume model tokens. Sessions remain replaceable callers.
- Detect stalls, outside failures, quota gaps and unknown effects, classify
  causes and apply bounded prescribed remedies. Unknown external effects
  cannot be blindly replayed.
- **Self-update is separate from self-healing:** System may propose a tested
  update/rollback; promotion is operator-governed by default. Unattended
  update requires explicit opt-in authority, evidence, rollout and rollback
  gates. Do not let a failing Worker rewrite its own verifier.

### Remote agent supervision: learn from Herdr, preserve System contracts

[Herdr](https://github.com/herdrdev/herdr) owns durable terminal panes,
workspace/tab layout, agent-status visibility and remote SSH machines;
[herdr-core](https://github.com/herdrdev/herdr-core) offers a headless
terminal/agent execution API, templates, child-agent lifecycle, parent
notifications, read/send/wait operations and remote machines.
See [RES-0012](../research/RES-0012-autonomous-work-platform-patterns.md).

Potential optional adapter: System dispatches an already-admitted
Worker Attempt to an isolated Herdr/core-managed local or remote process,
then receives lifecycle observations and exact Artifact outputs through the
existing WorkerPort/ACP boundary. **Herdr terminal idle/done is not a
System verified Work outcome**; only System Verifiers may establish that.
Keep remote credentials and access scope independent; loss of SSH/terminal
status must be distinguishable from the remote attempt's actual result.
Do not introduce two competing process supervisors for the same Attempt.

### Parallel read-only component audit (proposed experiment)

Use the **Specialist Review Team** strategy from section 2 to spawn several
*bounded subagent review attempts* from an existing Claude/Codex caller or
System Work, each with disjoint scope and minimum context. No code writes,
no dependency installs, no credentials, no push, no automatic patch/merge.

| Audit track | Owner/source to inspect | Questions and deliverable |
|---|---|---|
| A. Work lifecycle | \`packages/work\` | Ready-step routing, Item decomposition and claims, replay/recovery, deduplication, retry storm risk; cite source lines and tests |
| B. Host and security | \`packages/host\`, \`packages/app\` | Caller privilege provenance, \`force\`, approval boundary, MCP from different repos, Host restart/update safety |
| C. Worker runtime | \`packages/agents\`, optional ACP branches | Local launch/isolation, model/account routing, subagents, quota, cancellation, remote-runtime/Herdr adapter seam |
| D. Verifiers/effects | \`packages/verifiers\`, \`packages/effects\`, \`packages/artifacts\` | Independent evidence, ambiguous external effects, publish queue, Artifact trust and integration safety |
| E. Operator experience | \`tools\`, \`packages/app\`, \`docs/operations\`, \`workflows\` | Bootstrap, status, unattended dispatch, reporting, CI quality, minimal UX |

Audit orchestration: separate read-only workspaces/contexts; each reviewer
returns a structured **Audit Artifact** listing [component, finding, severity,
reproduction or source evidence, owner, suggested minimal fix, existing
coverage, confidence]. A separate synthesis subagent deduplicates claims
and cross-checks contradictions against code/tests. A verification step
tests the proposed assertions, prioritizes P0/P1/P2 and converts accepted
findings into small independent Items, **never bypassing human authority**.
Report both defects and "no change needed" components to avoid inventing
work. This PR defines the audit protocol; it does **not** assert that
subagents were spawned or the audit was performed.

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
records source-level research on Symphony, Herdr/Herdr Core, Gas City
(successor to retired Gas Town), Beads, Magentic-One, Temporal,
Anthropic's research agents and ACP. Reuse only the useful invariant or pattern at an existing System seam.
Do not vendor an orchestration framework, duplicate DSH, add model-specific
branches to Work or assume multi-agent beats single-agent.

Possible **sequenced experiments**, not authorized implementation Items:

1. **Bootstrap MVP:** plan / apply / check, reuse existing scaffold, test
   on three target repository shapes and through other project sessions.
2. **Multi-project visibility:** status of several repositories from one
   CLI/MCP caller, bounded priorities/quotas; no new Work state.
3. **Long-term delivery:** decompose a Markdown ROADMAP/PLAN/TODO into
   actionable Items and verified Works, then demonstrate unattended dispatch
   across session/Host restarts without a new Goal engine.
4. **Independent component audit:** read-only subagent tracks across five
   System boundaries, separate verified synthesis and minimal accepted Items;
   evaluate Herdr-managed remote attempt lifecycle as an optional adapter.
5. **Adaptive teams:** compare the three modes and the one-Worker baseline
   under shared load; observe merge conflicts, tokens and outcomes.
6. **Feedback and capability evolution:** failure taxonomy, remediation
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
