---
id: PROP-0002
type: proposal
status: draft
created: 2026-11-06
summary: Prioritize three-Worker Brainstorm using existing Claude/Codex adapters, keep Research execution-only for now, and defer Website Workers and stronger verification.
evidence: [RES-0005, RES-0006, RES-0004]
related: [ADR-0001, ADR-0002, ADR-0003, ADR-0004]
---

# Proposal: post-MVP-0 roadmap — Brainstorm first

**DRAFT roadmap, updated 2026-11-06. Not an accepted ADR or implemented
feature.** [PR #2](https://github.com/tsuuanmi/System/pull/2) implements
MVP-0 at `7099428` with Claude Code and Codex, Software Engineering,
Research, immutable Artifacts, Work replay and GitHub effects. This PR #1
contains **documentation only**. See the source-backed
[Brainstorm feasibility research](../research/RES-0006-brainstorm-workflow-feasibility.md)
and existing [component/plugin audit](../research/RES-0005-plugin-reuse-audit.md).

## Direction and scope

**Immediate product goal: make System useful for Brainstorming, not build a
third Worker/provider or more complex engine.**

- **Brainstorm now:** three *Worker executions* / roles using the existing
  **two configured runtime providers**, Claude Code and Codex, connected by
  immutable Artifact IDs. Two independent proposals and one synthesis.
- **Research now:** keep the **working Research flow** and its outputs.
  Upgrading report-level factual/claim verification is **future work**,
  not the next roadmap gate. The installed citation verifier can remain
  available but is not proof of report quality; a separately versioned
  exploratory workflow may omit verification completely.
- **Research with Website Worker later:** defer browser-driven/interactive
  website research, source snapshot/evidence pipeline, enhanced citation and
  claim verification until after the next MVP iteration, when that workflow
  is actually needed.
- **Security/isolation:** not the near-term product milestone; retain
  ADR-0004's existing boundary/deferral without claiming the trusted
  prototype is an adversarial sandbox.
- **Architecture:** Work remains primitive; Workflow is external config;
  Controller remains domain-agnostic; DSH/Cordis hosts registered Worker,
  Verifier and Effect capabilities. Do not create an Agent Team or new Work
  authority for the first three-step Brainstorm.

## Reference guidance from System 1

[RES-0006](../research/RES-0006-brainstorm-workflow-feasibility.md#system-1-as-a-reference-what-to-copy-conceptually)
audits System 1's built-in Brainstorm team, account-family diversity, ballots,
debate and scientific-research profile. **Adopt independent proposals,
provenance, and explicit synthesis; defer votes, session-affinity, persistent
team members and full team orchestration.** The current System Work Controller
and Workflow YAML remain authoritative.

## Observed progress and next priority

[PR #2](https://github.com/tsuuanmi/System/pull/2) has now implemented
Brainstorm B0–B2, fixed B4's SQLite and PID-lock races, and executed B3's
**15 Works across five briefs and three comparison arms**. The blind
operator scores are **still pending**, so do not claim three Workers are
more useful than one. Locally reported mean elapsed times were 37 seconds
for the single-Worker arm versus 157–162 seconds for three-attempt arms.
This is a meaningful cost to weigh against usefulness, disagreements
and actionable options; details are in [RES-0007](../research/RES-0007-brainstorm-and-concurrency-review.md).

**Next:** score B3 results blind; inspect the original proposals, not just
the synthesis; choose whether role-specific prompts or a different
synthesizer improve outcomes. Keep B4 regression tests. Research
claim-level verification and Website Worker remain future capabilities,
not gates for Brainstorm. The milestone table below is the **original
staged plan**, not a list of features still missing from PR #2.

## Ordered implementation roadmap

| Stage | Scope and output | Required gate | Priority |
|---|---|---|---|
| **B0 — Baseline** | Verify PR #2 tests/pinned DSH and `system workers` availability; characterize existing concurrency patch; preserve current MVP-0 behavior | Offline CI pass, no Work/Artifact regression, record setup and source revision | P0 |
| **B1 — Brainstorm config** | Add `workflows/brainstorm.yaml` and role-specific `brainstorm.*` capabilities mapped to the **existing Claude/Codex accounts** in a minimal profile patch; no new package | One brief -> two independent idea Artifacts -> one synthesis Artifact, using the same Work Controller; no mandatory verifier | **P0 / next feature** |
| **B2 — Real three-Worker proof** | Credential-gated Claude idea + Codex idea + Claude/Codex synthesis; cancellation/restart/replay; record route/executor, usage and outputs | Three recorded Worker attempts, both original ideas remain immutable, synthesis reads only their Artifact IDs, restart does not repeat completed calls | P0 |
| **B3 — Daily-use Brainstorm** | CLI discoverability/templates, read-only summary and Artifact inspection; varied real brainstorm briefs; single-worker comparison | At least 5 varied briefs; record costs/latency, novelty, diversity, usefulness and operator feedback, not only exit 0 | P1 |
| **B4 — Focused reliability** | Reproduce concurrent CLI same-Work stress and examine DSH `busy_timeout` patch; repair only demonstrated correctness defects | No lost update, duplicate dispatch or false replay success in controlled fixture | P1 / parallel technical track |
| **B5 — Extensibility proof** | If demanded, introduce one additional **optional capability** through a config-enabled plugin; reuse current registry | Disable -> explicit refusal, enable -> success, no domain-specific controller edit or second plugin manager | P2 |
| **Later — Website Research** | New Website Worker/browser adapter, source artifact provenance, optional citation/claim verifiers | A real interactive/gated source use case + controlled fixture proves need; no regression in existing research flow | After next MVP |

B0 and B4 are correctness guardrails, not an excuse to pre-empt B1 with
large infrastructure refactors. Do not block first Brainstorm on optional
Website Worker, new UI, MCP, DSH native Agent Team or advanced verifier.

## Exact B1 architecture: three roles, two runtime types

```text
              Brainstorm brief (Artifact ID)
                    /             \
        Claude ideation A       Codex ideation B
              |                    |
         proposal-a ID         proposal-b ID
                    \             /
            Claude/Codex synthesis
                     |
                summary ID
```

**Execution semantics:** controller currently schedules one ready step at a
time; this is not simultaneous parallel fanout. The two idea steps are
**logically independent** (they see only the brief), then synthesis explicitly
depends on both. Parallel scheduling is a later performance experiment.

**Routing:** existing registry selects the first matching account. B1 can be
done *without changing the workflow schema* by assigning role capability
labels such as `brainstorm.idea-a`, `brainstorm.idea-b`,
`brainstorm.synthesis` to the existing Worker accounts via config.
Preflight refuses unavailable capabilities. Do **not** assume the existing
Codex account already offers `research`; add only the role it can actually
execute. Generic capability labels are mapping data, not a new Worker type.
If explicit per-step Worker references are truly required later, propose a
narrow schema extension with tests instead of hardcoding vendor names.

**Output:** `file@1` text artifacts, each stored immutably with attempt
provenance, plus Work summary. No `verify` or `accept` node required in
initial `system.workflow/v1` (the current controller can close a workflow
after its Worker steps). `succeeded` means the declared steps produced
their artifacts, **not** that every idea is good or factually correct.

See [RES-0006](../research/RES-0006-brainstorm-workflow-feasibility.md) for
a complete illustrative YAML, source links and tests.

## Decision: should we add another Worker?

**Recommendation: NO, not now.**

- The next use case needs **three role executions**, not three new provider
  implementations. Reusing the two accounts is enough to test the real
  value of multi-perspective brainstorming.
- More Worker implementations increase credentials, runtime/usage parsing,
  maintenance and recovery surface without proving better brainstorms.
- Consider **another Worker only if** (1) a needed modality or provider
  capability is genuinely absent, (2) tests show the current Claude/Codex
  pair cannot meet a quality, cost or availability need, (3) the new adapter
  implements the existing WorkerPort without changing Work Controller,
  and (4) an opt-in trial shows measurable improvement.
- **Website Worker** is the most plausible *new modality*, but it is a
  **later Research-specific candidate** rather than a dependency of B1–B3.

## Components/plugins: use what exists first

| Component | Next action | Avoid |
|---|---|---|
| `@system/work` and Workflow YAML | **KEEP**: compile three steps, pin spec, persist events and replay | No team/chat board, no domain-specific controller |
| `@system/artifacts` | **KEEP**: proposals/synthesis and exact input IDs | No transcript sharing or second store |
| `@system/agents` | **REUSE**: Claude/Codex accounts, tier routing, native WorkerPort | No new provider or DSH model loop for Brainstorm |
| `@system/verifiers` | **KEEP AVAILABLE**: code/citation checks as currently implemented | Claim verification is future; no mandatory Brainstorm reviewer |
| `@system/effects` | **KEEP**: no new GitHub/side effects for text brainstorm | No auto-publish brainstorming output |
| DSH/Cordis plugin config | **REUSE**: profile patch role capabilities | No duplicate plugin manager |
| System 1 workflow/routing/evidence ideas | **ADAPT ONLY WHEN MEASURED**: diversity/feedback patterns | No monolithic workflow, peer messaging or vote engine |
| DSH Agent Teams / `dsh-jobs-local` | **DEFER**: separate Session/team authority; jobs are not durable Work | No premature runtime replacement |
| DSH `ctx.web`, Website Workers | **LATER**: research-specific source integration | No mandatory web fetch service in Brainstorm profile |

## Acceptance checklist for a local implementation agent

- [ ] B0: establish baseline from PR #2 and run existing CI/test commands.
- [ ] B1: create a valid `system.workflow/v1` Brainstorm YAML **outside engine code**.
- [ ] B1: configure existing Claude/Codex accounts to expose the three
  `brainstorm.*` role capabilities; no provider/Work Controller changes.
- [ ] B1: assert first and second idea steps receive **only the brief**,
  and synthesis receives **both exact proposal Artifact IDs**.
- [ ] B2: run three real attempts, including both Claude and Codex, and
  record provider/model/tier/attempt IDs.
- [ ] B2: kill/restart and prove finished idea steps were not re-executed.
- [ ] B2: no verifier required; output status never describes the result as
  fact-checked or approved.
- [ ] B3: run a few varied briefs and compare a one-Worker baseline for
  usefulness, diversity, latency and operator interventions.
- [ ] B4: maintain concurrency regression coverage; only escalate storage
  design on a reproduced correctness bug.
- [ ] Only after a new use case: evaluate Website Worker and claim-level
  Research verifier as separate future capabilities.

## What counts as done?

**Brainstorm MVP feature:** a human submits a brief and receives three
immutable, attributable Work outputs (two independent proposals, one
synthesis) through the *same* controller, using Claude and Codex on the
current DSH host. Run/retry/replay are inspectable. The implementation
does not claim formal answer quality or synchronous parallel execution.

**Research feature:** its existing end-to-end execution continues to work.
Do not turn claim-level Research verification into a current release blocker.
When Website Worker research becomes an active product goal, revisit evidence
and verification under a new proposal/ADR with measurements.

**Review dependency:** PR #2 is stacked on PR #1. This PR #1 change only
edits docs; the local agent should sync the updated documentation branch
into the implementation branch at an appropriate reviewable checkpoint.
