---
id: RES-0022
type: research
status: active
date: 2026-11-27
summary: Compare six agent workspaces against System and evaluate evidence-led reuse.
related: [RES-0015, RES-0016, RES-0017, RES-0018, ADR-0003, ADR-0011, ADR-0012, ADR-0016]
---

# Agent-workspace landscape and System integration options

**Research snapshot: 2026-11-27. Evidence and candidates, not an implementation decision.**
This comparison covers System, Orca, Paseo, Paradev, Orchestrator.inc, OpenHands Agent Canvas and MATE.
The question is not which project has the most features. It is which capabilities help System deliver more
verified product work per operator intervention without losing its responsibility boundaries.

This is a cross-project synthesis, not a replacement for the more detailed and commit-pinned
[Orca study](RES-0015-orca-study.md), [Orca failure-focused follow-up](RES-0016-orca-study-round-2.md)
or [Paseo/Paradev source study](RES-0017-paseo-paradev-study.md).
The latter include source-level findings and System Work evidence that this survey does not reproduce.

**Architecture follow-up:** [RES-0023](RES-0023-adaptive-component-evolution.md) records the
operator's adaptive-component direction, strategies A-D, the execution boundary,
reliability/security cases, comparative experiment and evidence-led replacement loop.
The [insight synthesis](RES-0024-adaptive-system-insights-and-adoption-gates.md)
maps the comparison to review gates without promoting research into a decision.

## Scope, evidence and confidence

- **System:** read the repository's dev branch on 2026-11-27, including
  [README](../../README.md), [PLAN](../../PLAN.md), [STATUS](../../STATUS.md),
  [Host](../architecture/host.md), [Workflows](../architecture/workflow-composition.md),
  [Artifact/verification contract](../architecture/artifact-verification.md) and
  [agents package](../../packages/runtime-cli/README.md). Source and tests win over prose.
- **Other projects:** public upstream README, documentation and selected implementation-oriented
  pages listed below. Their documented features are not independently load-tested here.
- **Previously inspected upstream code:** RES-0015 and RES-0017 pin upstream commits for detailed
  Orca, Paseo and Paradev claims; consult them before porting code. This survey instead records a
  dated documentation snapshot; upstream feature surfaces change quickly.
- **Evidence labels:** *documented* means the maintainer claims a feature; *implemented in System*
  means the current System source/docs support the claim; *candidate* means no decision or work item
  follows from this research alone; *unknown* means not verified from available evidence.
- **No common benchmark** was run for recovery, cost, latency, success rate, permissions or
  verification accuracy. A feature comparison must not be read as a quality ranking.

## The product boundary: two different questions

**Agent workspace question:** How can a person or coordinator launch and steer many live coding
sessions, inspect terminals and diffs, and turn CI or review feedback into the next agent action?

**System question:** What exact Work was authorized; which Account/Attempt performed it; what
immutable outputs, effects and evidence were recorded; which pinned criteria verified which result;
and which operator-only acts remain outside agent authority?

These are complementary questions. An editor that shows a green CI check can be useful without
implementing System's content-addressed Artifact verdict contract. Conversely, System's correct
verdicts need not imply an ergonomic terminal, mobile client or built-in review UI.

A practical decomposition for evaluating integrations is:

| Layer | Responsibility | Projects worth inspecting |
| --- | --- | --- |
| Interaction | Human attention, session UI, diff/PR review, mobile, notifications | Orca, Paradev, Paseo, Orchestrator.inc |
| Execution | Agent CLI/process, worktree, remote host, sandbox/backend, streaming | Paseo, Orca, OpenHands, MATE |
| Orchestration | Task decomposition, placement, messaging, dispatch, retries | Orca, Paseo, MATE, Orchestrator.inc |
| Governance | Admission, authority, Artifact identity, exact-subject verdicts, effects | System |
| Feedback | CI failures, merge conflicts, review findings, error evidence | Orchestrator.inc, Orca, System |

The layers are an analytical model, **not** an architecture already shared by all seven products.
For System, one Host remains the source of Work truth under [ADR-0007](../decisions/ADR-0007-one-long-lived-host.md)
and [ADR-0012](../decisions/ADR-0012-host-carries-works-on-never-picks-items.md).

## Capability comparison

"Yes" means the capability is documented or implemented, not that behavior was benchmarked.
"Partial" signals a narrower behavior or a declared experimental feature.
"Not established" means this research did not find equivalent evidence; it is not proof of absence.

| Capability | System | Orca | Paseo | Paradev | Orchestrator.inc | OpenHands Canvas | MATE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Several CLI agents | Selected adapters | Broad CLI roster | Broad providers | Broad CLI roster | Broad CLI roster | ACP and native | Crew: several |
| Concurrent worktrees | Yes | Yes | Yes | Yes | Yes | Backend-specific | Yes |
| Account/quota management | Headroom routing | Usage and switching | Provider-specific | Usage and switching | Agent-specific | Backend/model-specific | CLI owns login |
| Task/worker coordination | Workflow DAG | Structured, experimental | Agent-to-agent | CLI/MCP control | Orchestrator | Automations | Mate/Crew |
| Durable operation | Evented Work Host | Sessions and Runs | Daemon and sessions | Sessions/remote | Daemon and sessions | Backend-owned state | Background core |
| Exact-subject verifier | Yes | Not established | Not established | Not established | CI/review, not same contract | Not established | Reviewer, not same contract |
| Dedicated headless mode | Linux Host | orca serve (beta remote) | Daemon/CLI | Remote/cloud paths | Remote host experimental | Self-hosted backend | Go core; Linux experimental |
| Desktop/mobile views | CLI/MCP only | Yes | Yes | Yes | Yes | Browser-first | Console/web |
| Automation triggers | systemd caller | Bots/schedules | Schedules/plugins | Agent-driven workflows | Fleet/PR workflow | Schedule/webhooks | Mate-driven |
| Human-only authority | Required in System design | Coordinator approvals optional | Permission API | Harness-dependent | User approvals in UI | Backend-dependent | Captain/agent roles |

**Interpretation:** Worktree separation is not process sandboxing; provider subscriptions do not
necessarily imply safe multi-account rotation; CI green does not automatically prove a stable
Artifact/verifier binding; and a remote daemon does not by itself guarantee crash-safe effects.

## System: strengths, shipped boundaries and gaps

**Distinctive architecture.** System is a DSH/Cordis-hosted gate and ledger:
Work/Attempt/Artifact identities, immutable typed Artifact inputs/outputs, pinned Workflow specs,
recorded external effects, verifier criteria bound to the exact subject, and replay from
observations rather than re-running a model. The Host owns concurrent Works and recovery.
The caller, not the Host, selects Items; the Host schedules ready steps within admitted Works.

**Implemented strengths (check source if changed):**

1. Workflow DAGs and reusable develop, research, brainstorm, hygiene and code-checks compositions.
   Parallel independent steps, Work retries and Account slots are explicitly recorded.
2. CLI adapters for Claude Code, Codex and Antigravity; optional ChatGPT Website Worker.
   Roles/Abilities/Tiers and multiple Accounts support quota/headroom-aware admission and routing.
3. Bounded automatic rework after a failing verifier or rejected effect, with previous output and
   failure evidence references; retries cannot silently adopt a verdict for a different subject.
4. GitHub publication, merge integrity checks and the repository's pinned checks; a model's final
   message alone is not an accepted Work. Research citation checking is narrower than proving every
   claim in a report; brainstorm can deliver Artifacts without an independent verifier.
5. Self-development through accepted STATUS Items, scheduled caller sessions and outcome reporting.
   PLAN records measure definitions and caveats, not a benchmark against the projects in this survey.

**Gaps relevant to other projects:** no comparable visual fleet console; live terminal/diff review
and mobile attention surfaces are limited; supporting new provider CLI protocols still requires
adapters; resource isolation by default and live observability remain work in progress or depend
on the current deployment (structured failure evidence and process identity are in: reopen-1,
finish-1, pid-1). Reuse a third-party UI/runtime only when it
reduces operator time or demonstrated Outside failures, not solely to match feature lists.

**Security state at this snapshot (the one home for it in RES-0022 to RES-0024):**
[ADR-0016](../decisions/ADR-0016-the-gate-is-enforced-by-reachability.md) was accepted on
2026-11-27, and iso-1 to iso-3 were released as 0d63354 the same day (PLAN section 3).
Enforced: the Operator socket (iso-2), the Scheduled session's layer (iso-3) and, since
vagain-1 (2026-11-27), verifying again (`work.verifyAgain`, an `operator` operation). The CLI
Worker layer is the per-Account `sandbox` option, off by default; on 2026-11-28 it was on for
`claude-code/c4`, `antigravity/a1` and `antigravity/a2`, and default on is the Operator's
decision (ADR-0016 decision 6). Not covered by the ADR: required checks run the change's own
code without the layer (`packages/verifiers/src/checks.ts`). So **do not claim the isolation
holds for every Worker process** until that is resolved.

## Orca: agent IDE, fleet coordination and remote runtime

**What stands out:** broad CLI agent support with chat/TUI handoff; Git worktrees; diff annotations;
browser/computer interaction; bots sourced from GitHub, Linear and Slack; desktop and mobile
interaction; account usage and reset visibility; remote server ownership of sessions.
The [usage guide](https://orca.dev/docs/agents/usage-tracking) explicitly separates account usage
from estimated costs and warns that inferred model prices are not provider bills.

**Orchestration nuance:** [Runs, Tasks, Dispatches, messages and gates](https://orca.dev/docs/cli/orchestration)
give useful ownership, acknowledgements, heartbeats, and dispatch-scoped completion.
This structured layer is **experimental**; the old coordinator-start/orchestration-run commands
are retired, and the Run itself does not schedule workers. Do not describe Orca as a stable
fully autonomous scheduler solely because these objects exist.

**Headless nuance:** [orca serve](https://orca.dev/docs/remote-servers) can own the runtime on a
headless Linux host, with service-managed startup and remote/mobile pairing. Remote servers are
beta; the guide advises a trusted private network and per-client revocable grants.
[Cloud VM recipes](https://orca.dev/docs/ways-to-run) are another optional execution mode,
not evidence that every local worktree is sandboxed.

**System can learn:** dispatch and generation identity, uncertainty after start/stop,
structured command receipts; terminal-to-Artifact references; quota visibility; clear per-step
human attention; strong docs around headless pairing and account provenance.
The source-level [RES-0015](RES-0015-orca-study.md) and
[RES-0016](RES-0016-orca-study-round-2.md) identify concrete candidates and which were already
implemented or settled.

**Do not copy blindly:** free-text worker_done as verification authority, mutable conversational
handoffs as the only durable contract, auto/coordinator approval for operator-only acts, or a
second scheduler competing with System's Host. An Orca Worker result remains an observation
until a System Artifact and Verifier make it admissible.

## Paseo: clean daemon/client separation and remote CLI

**What stands out:** a local-first daemon that owns process lifecycle and streams over WebSocket,
with separate desktop, web, iOS, Android and CLI clients; multi-provider agents, parallel worktrees,
agent-to-agent delegation, plugin extensions, optional end-to-end encrypted remote relay.
The public [server guide](https://github.com/getpaseo/paseo) documents headless CLI installation,
remote --host usage and an [SDK](https://github.com/getpaseo/paseo/blob/main/public-docs/sdk/index.md) client.
The [architecture](https://github.com/getpaseo/paseo/blob/main/docs/architecture.md)
identifies server, app, CLI, desktop and relay components.

**System can learn:** a narrow daemon API independent of UI; stable session create/observe/stop
and stream contracts; resumable remote sessions; adapter selection by provider;
structured CLI exit/status and compatibility probes. A read-only web console may consume a
System operation schema without duplicating System's store.

**Tradeoffs and limits:** a Paseo daemon is a second lifecycle owner; a relay and its security
model add operational complexity; plugin code receives substantial privileges. The source-level
[RES-0017](RES-0017-paseo-paradev-study.md) already covers permission, process and event-schema
candidates. "Easy to integrate" is a hypothesis: CLI/SDK support does **not** yet establish a
System-compatible final-result, idempotency or verifier contract.

## Paradev: parallel workspace UX and review workflow

**What stands out:** one branch/worktree and terminal per agent task, at-a-glance busy/idle
statuses, chat/TUI sessions, diff comments, GitHub PR checks, in-app browser and design targeting,
plus CLI/MCP and remote/cloud options. It is particularly useful as a reference for an
operator's view of **which agent needs attention right now**.

**System can learn:** worktree and session navigation, diff-to-agent feedback, status rollups,
side-by-side comparison of two attempted solutions, and high-signal UI without moving ownership
of Work decisions into a frontend. Read [Paradev README](https://github.com/ParadevAI/Paradev)
alongside [RES-0017](RES-0017-paseo-paradev-study.md).

**Tradeoffs and limits:** local worktrees are not a security boundary, and merges may conflict.
The [Codex guide](https://github.com/ParadevAI/Paradev/blob/main/apps/docs/content/docs/agents/codex.mdx)
describes default flags bypassing Codex approval prompts and sandbox; those defaults must not
be copied into System. Cloud isolation and local privilege are different trust models.

## Orchestrator.inc: the CI/review/merge feedback loop

**What stands out:** a fleet board organized by actionable state; worker/branch/worktree ownership;
reviewer agents; routing failing CI, PR review comments and merge conflicts back to the worker
responsible for the branch; remote hosts and cloud workers are available, with remote-host
functionality described as experimental in upstream documentation.

**System can learn:** connect every actionable failure to its owning Attempt and exact revision,
show the next action rather than an undifferentiated session log, and keep a clear operator
attention queue. Its
[documentation map](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/documentation-map.md)
also separates generated/machine contracts from fallible explanatory prose.

**Tradeoffs and limits:** triggering another agent turn on every failure can waste quota or
replay unsafe effects. System should preserve pinned checks, bounded retries and the distinction
between a change failure and an Outside failure. PR review is useful evidence but never a
replacement for a required verifier.

Sources: [project README](https://github.com/OrchestratorInc/agent-orchestrator) and the
[product introduction](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/frontend/src/docs/content/index.mdx).

## OpenHands Agent Canvas: backend and trust-boundary abstraction

**What stands out:** a browser-first developer control surface; local and remote backends,
Docker/VM/cloud environments, OpenHands agents and ACP-compatible third-party agents;
automations integrating webhooks, GitHub and Slack.
The [overview](https://github.com/OpenHands/docs/blob/main/openhands/usage/agent-canvas/overview.mdx)
explicitly separates browser, backend, workspace, agent/model and trust boundary.

**System can learn:** represent execution location and isolation as properties of a runtime
backend rather than of a UI; publish a compatibility contract for ACP-like agents; design
a control center that can switch local, server and sandboxed backends without changing Work
identity. Backend capabilities and security must be inspected, not inferred from product names.

**Tradeoffs and limits:** an ACP conversation/session is not automatically a System Work or
Attempt; cloud and self-hosted backends have distinct credential, egress and retention risks.
Do not import a second agent loop, storage authority or unbounded automation engine merely
to reuse the browser UI.

Source: [OpenHands repository](https://github.com/OpenHands/OpenHands) and
[Agent Canvas overview](https://github.com/OpenHands/docs/blob/main/openhands/usage/agent-canvas/overview.mdx).

## MATE: small supervisor/crew architecture

**What stands out:** a Go core with terminal console and web visualizations; one Mate per
project decomposes user work and starts multiple Crew agents, typically in separate worktrees;
a separate reviewer Crew can check results before local merge or PR creation. CLI Workers may
use Claude Code, Codex, Pi or Grok.

**System can learn:** a compact manager/worker interaction vocabulary, readable progress and
human attention surfaces, independent reviewer roles, and resource-efficient process control.
It is a useful lightweight reference rather than a replacement for System's durable ledger.

**Tradeoffs and limits:** Mate's README describes macOS as its daily-used platform and
Linux/WSL2 as experimental; it does not establish artifact-bound acceptance, quota admission
or the same crash/effect semantics. The Mate coordinator is an agent, whereas System's
[ADR-0012](../decisions/ADR-0012-host-carries-works-on-never-picks-items.md) forbids the Host
itself from picking Items. Keep that boundary.

Source: [MATE repository](https://github.com/ericsnguyen9941/mate).

## What System should reuse, test, or decline

The order below is **research priority, not approved backlog**. PLAN's current rule still
applies: create System Items from actual product Batch evidence, a promised safety guarantee,
or deletion of unused code. The operator settles Intent and approval.

| Priority | Candidate and inspiration | Why it might matter | Gate before an Item |
| --- | --- | --- | --- |
| P0 | Enforce the accepted ADR-0016 trust boundary (System) | Prevent worker-to-operator escalation/push | iso-1 to iso-3 released; see the security state above for what remains |
| Done | Reopen with complete structured failure evidence (Orca, AO) | Reduce wasted repair attempts | Implemented: reopen-1, finish-1 (reopen-2 open) |
| P1 | Work/Attempt attention and live observation view (Orca, Paradev, AO) | Reduce operator minutes per Item | Read-only API/CLI spike; compare before/after |
| P1 | Headless external-runtime adapter (Paseo, Orca) | Reuse CLI/session ecosystems without replacement | Demonstrate five protocol invariants below |
| P1 | Process start/stop uncertainty and fencing (Orca, Paseo) | Prevent misidentified or duplicated Attempts | Mostly implemented (pid-1, `attempt-lost`, `WorkerPort.gone`/`end`); no attempt-id fence on `observed` |
| P2 | Write-path overlap and merge preview (Paradev, AO) | Prevent cross-worktree merge conflicts | Demonstrate recurring conflict class |
| P2 | Role x Runtime x Model evaluation (System records, Orca) | Route by measured task fit | Enough labelled attempts and correct denominators |
| P2 | Backends/trust-boundary descriptor (OpenHands) | Explicit local/VM/container capabilities | A real second backend requires it |
| P2 | Narrow dashboard + manager/crew visual vocabulary (MATE) | Explain fleet state without a full IDE | Operator usability test shows saved time |

**Already in System; do not re-propose:** multiple Account identity and headroom routing,
Work/Attempt IDs, idempotent command receipts, pinned verifier criteria, isolated worktrees,
bounded retry, a DSH-hosted long-lived Host, and the scheduled caller.
Read [RES-0015](RES-0015-orca-study.md) for the complete "already present" mapping and
[RES-0016](RES-0016-orca-study-round-2.md) for failure observations.
Role x Runtime x Model routing is already gated by PLAN section 3 ("Roles by fit… by configuration
only") and section 4 ("Adaptive routing only on a measured need").

### Example: feedback without an agent-driven acceptance gate

1. A System Work starts an implementation Attempt against a specified base commit.
2. The Worker emits a change Artifact with exact commit/tree identity and a bounded summary.
3. A pinned check produces a Verdict and evidence Artifacts for that exact subject.
4. On a change failure, a declared bounded retry creates a **new** Attempt with prior output,
   failing command and evidence references; on an Outside failure the recovery path differs.
5. Only a verified, still-current subject can reach the configured publish/accept effect;
   operator-only permissions never flow back through a worker terminal or a coordinator bot.
6. The console displays Task, Account, Attempt, failure class, last observation, evidence link
   and human next action, without becoming another authority over records.

The behavior in steps 1-5 overlaps existing System mechanisms; the potential new work is
better evidence delivery and observation, **not** rebuilding a generic orchestration loop.

## Proposed external runtime spike: Paseo first, Orca second

**Hypothesis, not decision:** Paseo's daemon + CLI + TypeScript SDK may provide a smaller
integration boundary for an unattended Linux host; Orca's CLI and headless orca serve
provide a strong second candidate. Neither has been run with System in this survey.

Do **not** embed both schedulers with unrestricted authority. System remains owner of
Work/Attempt IDs, admission, replay, verification, effects and operator-only acts.
An external runtime may own **only** a supervised execution session.

A minimal adapter must prove these five invariants:

1. **Launch identity:** System starts exactly one session for one Attempt with an explicit
   provider, workspace, capability and correlation ID; repeated launch does not duplicate it.
2. **Observe and reconcile:** stdout, state, timestamps and an uncertain launch/stop are
   observable after a Host or remote-runtime restart; unknown is not reported as success.
3. **Bounded result:** obtain structured completion and an immutable snapshot of output
   and exact git commit/tree; free-form worker_done alone never passes a verifier.
4. **Authority isolation:** the remote agent cannot reach operator-only operations or push
   protected branches; credentials, callbacks, network and child process permissions are
   checked against ADR-0016, not assumed safe because a worktree exists.
5. **Cancellation and recovery:** duplicate stop, abandoned session, delayed heartbeat,
   stale completion and lost network have explicit outcomes and testable recovery paths.

**Spike protocol:** choose one non-production repository with pinned checks; record versions,
runtime mode, Account identity and scope. Run one happy-path commit, one intentional test failure,
one interrupted launch/reconnect, one duplicate command, and one forbidden operator action.
Record exact outputs, elapsed time, operator touches and whether any new authority or state store
was required. Accept a backend only if all five invariants hold without altering System's
verification semantics. Never hand live subscription tokens to an unreviewed plugin or relay.

**Fallback:** keep direct Claude Code/Codex/Antigravity adapters and adopt only UI/observability
patterns if external runtime composition proves fragile or costly. The value of an integration is
measured by downstream verified Items and operator time, not by the size of its provider roster.

## Decisions intentionally not made

- No decision to replace DSH/Cordis, System's Host, Artifact store or verifier registry.
- No auto-selection of new STATUS Items by a coordinator or an autonomous Host.
- No transfer of operator approval, verify-again or protected-branch push to a worker.
- No claim that other products lack security or verification; equivalence to **System's**
  exact-subject contract was not established by the reviewed evidence.
- No unconditional adoption of subscription proxies, credential sharing, relays or plugins.
- No adoption of a desktop/mobile UI without evidence that it reduces operator effort.
- No automatic creation of Items merely because a competitor ships a feature.

## Follow-up questions for a measured decision

1. Which operator actions consume most minutes across the next three product Batches?
2. How many resumed/reopened Works lack evidence sufficient to repair on their next Attempt?
3. Can one external backend pass the five invariants **without** privileged host access?
4. Does live observability lower intervention or merely increase monitoring overhead?
5. For each Runtime/Role, how often are usage and cost unknown or partial?
6. Would a read-only console suffice, or is an interactive IDE justified by measured results?

## Primary sources and internal research

| Project | Public evidence |
| --- | --- |
| System | [Product Charter](../requirements/purpose.md), [PLAN](../../PLAN.md), [ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md), [ADR-0016](../decisions/ADR-0016-the-gate-is-enforced-by-reachability.md) |
| Orca | [README](https://github.com/stablyai/orca), [orchestration](https://orca.dev/docs/cli/orchestration), [remote servers](https://orca.dev/docs/remote-servers), [usage](https://orca.dev/docs/agents/usage-tracking) |
| Paseo | [README](https://github.com/getpaseo/paseo), [architecture](https://github.com/getpaseo/paseo/blob/main/docs/architecture.md), [orchestration](https://github.com/getpaseo/paseo/blob/main/public-docs/orchestration.md) |
| Paradev | [README](https://github.com/ParadevAI/Paradev), [Codex security flags](https://github.com/ParadevAI/Paradev/blob/main/apps/docs/content/docs/agents/codex.mdx) |
| Orchestrator.inc | [README](https://github.com/OrchestratorInc/agent-orchestrator), [docs map](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/documentation-map.md) |
| OpenHands | [README](https://github.com/OpenHands/OpenHands), [Agent Canvas overview](https://github.com/OpenHands/docs/blob/main/openhands/usage/agent-canvas/overview.mdx) |
| MATE | [README](https://github.com/ericsnguyen9941/mate) |
| Previous System research | [RES-0015](RES-0015-orca-study.md), [RES-0016](RES-0016-orca-study-round-2.md), [RES-0017](RES-0017-paseo-paradev-study.md), [RES-0018](RES-0018-anthropic-review-verification-source-control.md) |

**Attribution and validity:** This document is an original comparative summary and copies no
upstream source code. Porting any implementation requires reviewing the upstream license,
pinned commit and security model. External docs were consulted on 2026-11-27; features, status
and URLs may change. No external system was installed, authenticated or executed for this note.
