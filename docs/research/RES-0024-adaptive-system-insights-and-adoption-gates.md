---
id: RES-0024
type: research
status: active
date: 2026-11-27
summary: Eight strategic insights and staged evidence gates for adapting System components safely.
related: [RES-0022, RES-0023, RES-0015, RES-0016, RES-0017, ADR-0012, ADR-0016, ADR-0018, ADR-0019]
---

# Adaptive System: eight insights and adoption gates

**Research synthesis, 2026-11-27. Not an accepted decision, requirement, runtime design,
or permission to add STATUS Items.** This is an executive/actionable synthesis of
[RES-0022](RES-0022-agent-workspace-landscape.md) (project evidence) and
[RES-0023](RES-0023-adaptive-component-evolution.md) (architecture and replacement protocol).
Detailed source claims, caveats and implementation alternatives have **one home**
in those documents; follow links rather than copying their large comparisons here.

The guiding question is not "How can System have more Agent IDE features?" but
"How can System deliver more **verified, durable outcomes per operator act** while
being able to replace any implementation that stops serving that goal?"

## Eight insights

| # | Insight | Consequence for System | Existing evidence / boundary |
| --- | --- | --- | --- |
| 1 | Do not compete feature-for-feature with an Agent IDE. | Reuse UI and session tools where useful; do not copy a whole IDE. | [Landscape](RES-0022-agent-workspace-landscape.md) |
| 2 | Work continuity matters more than the survival of any Worker. | Keep Work, Attempt, Artifact and criteria independent of provider sessions. | [Charter](../requirements/purpose.md) |
| 3 | Adaptivity is a measured ability to **replace components**, not a plugin count. | Consider keep, improve, reuse, adapt/fork, build, retire, then revisit. | [Evolution](RES-0023-adaptive-component-evolution.md) |
| 4 | Work orchestration and execution must have distinct owners. | System owns acceptance and retries; backend owns bounded agent execution. | [Control plane](../architecture/control-plane.md) |
| 5 | Recovery semantics are harder than SDK integration. | Prove idempotency, reconnect, fencing and explicit unknown outcomes. | [Host](../architecture/host.md) |
| 6 | Security is enforced where the Worker actually runs. | External daemons cannot bypass the required reachability boundary. | [ADR-0016](../decisions/ADR-0016-the-gate-is-enforced-by-reachability.md) |
| 7 | Copy mechanisms, not entire products. | Study Orca supervision, Paseo SDK, Paradev UX, AO feedback, ACP protocol. | [Landscape](RES-0022-agent-workspace-landscape.md) |
| 8 | Optimize verified outcomes, not agent turns or provider count. | Measure verified Items per operator act, reliability, cost and upkeep. | [Charter](../requirements/purpose.md) |

**Strategic synthesis:** "System owns the truth of work, not necessarily the machinery
performing it." Keep the system's **semantic invariants** stable; improve the
**implementation behind them** whenever evidence supports a better alternative.

The rationale is **not** that System should eliminate orchestration. The Host still
owns Work orchestration. What may be externalized is supervised process/session execution,
provider protocol, worktree tooling or presentation, subject to contract checks.

## What is already true, and what is not yet proved

| Claim | Confidence and status |
| --- | --- |
| System's Charter defines a durable Work ledger and pinned verifier acceptance. | Accepted intent, source/tests govern implementation |
| System already has provider CLI adapters and a shared Attempt lifecycle. | Source-backed, see [agents](../../packages/runtime-cli/README.md) |
| Paseo exposes a public client SDK and daemon-owned sessions. | Documented upstream, **not tested with System** |
| Orca exposes rich session supervision and experimental structured orchestration. | Documented upstream, **not tested with System** |
| ACP may reduce bespoke provider integrations. | Hypothesis; v2 is still draft, test capability/version support |
| A third-party runtime improves System's success, security or upkeep. | **Unknown** until a common benchmark |
| ADR-0016's desired isolation automatically applies to external daemon children. | **False assumption**: test actual child reachability |
| Swapping a Verifier implementation is equivalent to changing acceptance rules. | **False**: pinned criteria and exact-subject semantics stay |

Do not promote a research hypothesis to "implemented", "approved", or "safe"
from an impressive demo, a README, an AI-generated assessment, or a green
result belonging to the wrong commit.

## Where to learn and where not to copy

| Project | Learn | Reject or inspect before adoption |
| --- | --- | --- |
| Orca | Supervision, receipts, dispatch identity, attention UX | Coordinator approval and duplicate Work authority |
| Paseo | Headless daemon/client/SDK and reconnect | Second lifecycle owner, relay or unrestricted access |
| Paradev | Isolated worktree UX, diff review and parallel awareness | Worktree as security boundary; unsafe approval bypass |
| Orchestrator.inc | Failure-to-owning-worker CI/review feedback | Unbounded auto-retry as acceptance |
| OpenHands | Backend/sandbox trust-boundary modeling | Assuming all backends share the same privileges |
| MATE | Compact manager/crew workflow and visual summaries | Letting a manager agent authorize System Items |
| ACP | Session and provider interoperability contracts | Assuming a draft protocol equals a verifier contract |

The detailed upstream links, version caveats and attribution are in RES-0022/0022.
Avoid collecting redundant notes about the same mechanism in every directory.

## Adoption gates for local review and implementation

**Gate 0 — Reconcile the present repository.** Read current source, tests,
[STATUS](../../STATUS.md), [PLAN](../../PLAN.md), [Charter](../requirements/purpose.md),
[ADRs](../decisions/README.md), RES-0022/0022 and recent Works. Some items
mentioned in research may now be complete. Avoid duplicate Items and stale
"implemented" claims. Verify the existing docs/tooling before editing.

**Gate 1 — Observe and choose a real bottleneck.** Quantify failures, operator
touches, time to verified resolution, usage gaps or maintenance cost using
System records where available. Explicitly compare (a) improving the native
path, (b) reuse, (c) adapt, (d) a focused better internal build.
If no meaningful bottleneck exists, record why no component should change.

**Gate 2 — Draw a minimal boundary.** Identify the *existing* seam
(`WorkerPort`, then `Turn`, then a CLI's `CliAdapter`). Decide whether a runtime,
read-only observation view, error-evidence improvement or another component is
the smallest useful slice. State who owns timeout, retry, credential scope,
process/session, Workspace, log, Artifact and publish/approve authority.
Avoid a universal plugin framework and competing schedulers.

**Gate 3 — Contract and adversarial fixtures before implementation.**
Define stable correlation/Attempt identity, lifecycle states, provider-account
identity, evidence references, version pinning and rollback expectations.
Add tests that would fail on the current defect or proposed unsafe behavior.
An external backend's "idle", "success" or "worker_done" is never a verdict.

**Gate 4 — Feasibility and comparative measurement.** Reproduce the same
Task and pinned checks on isolated workspaces. Native is the baseline;
Paseo is one potential first external implementation, Orca a follow-up
candidate and ACP a protocol sub-study. This is **not** an instruction to
install or enable every backend. Run happy-path, failing check, restart,
lost acknowledgement, stale result, cancellation, quota alias and
permission-boundary cases. Unknown outcomes cannot be treated as success.

**Gate 5 — Operator-controlled promotion.** Summarize contract test
results, maintenance burden, operator touch reduction, failure classes,
new trust paths, rollback and negative findings. If architecture, security,
workflow authority or acceptance criteria change, draft a proposal/ADR
for operator review. Do not claim an operator approval occurred without
an actual decision. A safe small change within existing accepted policy
may proceed as an ordinary verified Work with appropriate evidence.

**Gate 6 — Narrow implementation, canary and retirement.** Keep
direct adapters as a fallback; gate experimental backends off by default;
bind all changes to tests and source-local docs. Demonstrate rollback,
historical event replay and in-flight drain. Retire the displaced component
only after measured improvement and no invariant regression.

These gates describe **review order**, not a new System Workflow engine.
The operator can decide to stop after Gate 1, or favor improving the native
lifecycle instead of adding any backend.

## Essential test matrix

| Scenario | Refusal or success condition |
| --- | --- |
| Lost launch acknowledgement | Reconcile by stable identity; no duplicate execution |
| Host or daemon restart | Recover observed state, or record unknown explicitly |
| Repeated cancel and stale completion | Generation fencing; no later Attempt corrupted |
| Backend reports done but output absent | Fail check / hold; never accept final chat text |
| Failing pinned test | Exact failing subject, reproducible evidence and bounded repair |
| External daemon spawns unsandboxed Worker | Reject integration until real child isolation is proven |
| Same provider Account through two adapters | Deduplicate account identity and quota pool |
| Upgrade, downgrade and rollback | Old records replay; no accidental migration of verdicts |

The currently accepted
[ADR-0016](../decisions/ADR-0016-the-gate-is-enforced-by-reachability.md)
must not be treated as fully enforced simply because the design was accepted.
Its state on 2026-11-27 is in [RES-0022's security state](RES-0022-agent-workspace-landscape.md).

## Review deliverables for a local System session

1. **Gap report:** each of the eight insights mapped to
   implemented / partial / missing / contradicted / not applicable,
   with code paths, tests and exact evidence.
2. **Decision matrix:** keep, improve, reuse, adapt or build for each
   observed bottleneck, including security and upgrade/rollback cost.
3. **One smallest measurable slice:** proposed scope, explicit non-goals,
   affected owners, current baseline, red tests, rollout/rollback, criteria.
4. **Work plan:** dependencies and small independent Items, but only
   after checking the operator's accepted scope and existing STATUS Items.
5. **Implementation evidence:** Work/Attempt IDs, artifacts, check results,
   PR URLs and unresolved operator decisions; no fabricated success claims.

**Local execution preference:** first review this research PR as a docs-only
evidence package. Use separate implementation PR(s) against the appropriate
repository branch after a scope/authority decision; do not silently convert
a research PR into a large framework rewrite. Start from real measured work
and prefer one verified vertical slice to a general plugin system.

## Review against the code, 2026-11-27 (origin/dev 70bd7e4)

Gates 0 and 1, run by a caller session with two citation-verified System Works
(work:aabc2f0f reliability, work:ccdc5472 security) and a read of the Host's records.
Baseline, `system work report --since 2026-11-20`: 257 Works, Verified Success Rate
225/252, 4.35 Items merged per operator act (34 acts: 17 Intents, 12 releases, 5 touches),
Recurring Failure Rate 51/79, Escaped Defect Rate 11/148, Time to Verified Resolution
median 5.0 min (p90 20.6 min), cost known for 170 of 225 accepted Works.

| # | Coverage | Evidence (source, tests, records) |
| --- | --- | --- |
| 1 | Implemented by design | No console; CLI and MCP only (ADR-0011, packages/app) |
| 2 | Implemented | `attempt-lost` on restart, slot held until `gone`, verified-identity `end` (work:aabc2f0f) |
| 3 | Partial | `work.report` measures exist; no per-Runtime split, though records show it (below) |
| 4 | Implemented | Controller owns retry and acceptance; `WorkerPort` seam; web Runtime is non-CLI |
| 5 | Mostly | Effects: intent before apply, reconcile, never blind retry. Gaps: no attempt-id fence on `observed`; a lost launch reads as a clean loss |
| 6 | Partial | Layer on 1 of 8 CLI Accounts (`claude-code/c4`); checks run the change's code unwrapped; verify-again on the caller socket |
| 7 | Implemented as practice | RES-0015/16/17 mechanisms adopted: pid-1, qw-1, idle-1, reopen-1, finish-1, ratchet-1 |
| 8 | Implemented | Headline is Items per operator act; Codex and Antigravity costs are partial |

**The measured bottleneck is feedback, not execution.**
- 16 of the 18 `change:docs` failures are DOC-IMP-001. `tools/docs.py impact` diffs `base...HEAD`,
  which misses the uncommitted change a Worker leaves. So the Worker's own docs check passes, and
  the Verifier fails. That costs about 16 of 56 reopen rounds and causes most `docs-waivers` conflicts.
- 12 of 14 `unknown` failures are Antigravity attempts: 13 of 46 Antigravity attempts failed,
  against 2 of 211 Claude Code attempts.
- No Work failed for want of a session daemon or a protocol.

**Component decisions:**
- Keep the Host, controller, effects and `WorkerPort`.
- Improve docs impact, verify-again authority, the shared-sign-in slot (agyconc-1) and
  per-Runtime reporting.
- Defer Paseo, Orca and ACP until a Work fails for want of one (PLAN section 4). A spike
  would be one `WorkerPort` row whose children run in System's layer.
- Do not add an ExecutionBackend interface.

**Operator decisions raised:** layer default on; checks inside the layer (outside ADR-0016's
scope today).

**Follow-up, 2026-11-28 (origin/dev 69f23f7).**
- Done:
  - vagain-1 (`work.verifyAgain`, operator socket), agyconc-1 and authgate-1 merged.
  - ADR-0018 made `WorkerPort` the one Runtime registry, as the decisions above assumed.
  - The layer is on for 3 Accounts (`claude-code/c4`, `antigravity/a1`, `antigravity/a2`).
- Not done:
  - DOC-IMP-001 remains the top class: 12 failures in 11 of 38 Works since the review.
  - `tools/docs.py impact` still diffs `base...HEAD`. rel-3 (ADR-0019) rewrites `impact` to
    read trailers and should also read the working tree.
- Measured over 2026-11-27T10:00Z to 2026-11-28:
  - 38 Works; Verified Success Rate 31/35.
  - 3.1 Items merged per operator act.
  - Recurring Failure Rate 15/28.

## Related sources

- [RES-0022](RES-0022-agent-workspace-landscape.md): comparison and project sources.
- [RES-0023](RES-0023-adaptive-component-evolution.md): replacement loop and boundary sketch.
- [RES-0015](RES-0015-orca-study.md),
  [RES-0016](RES-0016-orca-study-round-2.md),
  [RES-0017](RES-0017-paseo-paradev-study.md): deeper source studies.
- [Product Charter](../requirements/purpose.md),
  [Control plane](../architecture/control-plane.md),
  [Verifier contract](../architecture/artifact-verification.md),
  [ADR-0016](../decisions/ADR-0016-the-gate-is-enforced-by-reachability.md).
- [Paseo SDK](https://github.com/getpaseo/paseo/blob/main/public-docs/sdk/index.md);
  [Orca orchestration](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/cli/orchestration.mdx);
  [ACP](https://agentclientprotocol.com).

**Limits:** no live Paseo/Orca/ACP integration or cross-backend benchmark
has been completed as part of this research. Implementation must be
conditional on the checks and actual approval boundaries above.
