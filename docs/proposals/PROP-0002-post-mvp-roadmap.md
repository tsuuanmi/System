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

- **Brainstorm now:** three *Worker executions* using the two configured
  runtime providers, Claude Code and Codex, connected by immutable Artifact
  IDs: two independent proposals and one synthesis. The composition is
  [Brainstorm composition](../architecture/brainstorm-composition.md); the
  source-backed feasibility is
  [RES-0006](../research/RES-0006-brainstorm-workflow-feasibility.md).
- **Research now:** keep the working Research flow. Report-level
  factual/claim verification is **future work**, not a roadmap gate; the
  installed citation verifier is not proof of report quality, and a
  separately versioned exploratory workflow may omit verification.
- **Research with Website Worker later:** browser-driven/interactive
  research, source snapshots and enhanced citation/claim verification wait
  until that workflow is actually needed.
- **Security/isolation:** not near-term; ADR-0004's boundary/deferral stands
  without claiming the trusted prototype is an adversarial sandbox.
- **Architecture:** Work stays primitive, Workflow external config, the
  Controller domain-agnostic, DSH/Cordis hosts the Worker, Verifier and
  Effect capabilities. No Agent Team or new Work authority for Brainstorm.

[RES-0006](../research/RES-0006-brainstorm-workflow-feasibility.md#system-1-as-a-reference-what-to-copy-conceptually)
audits System 1's Brainstorm team. **Adopt independent proposals,
provenance and explicit synthesis; defer votes, session-affinity,
persistent team members and full team orchestration.**

## Observed progress and next priority

Brainstorm B0-B2 and the B4 fixes are implemented, and B3 executed **15
Works across five briefs and three comparison arms**
([RES-0007](../research/RES-0007-brainstorm-and-concurrency-review.md)). The
blind operator scores are **still pending**, so do not claim three Workers
are more useful than one: mean elapsed time was 37 s for the single-Worker
arm against 157-162 s for three-attempt arms.

**Next:** score B3 blind; inspect the original proposals, not just the
synthesis; choose whether role-specific prompts or a different synthesizer
help; keep the B4 regression tests.

## Staged plan (original; B0-B4 done)

B0 (P0) verified tests, the pinned DSH and `system workers` with no
Work/Artifact regression. B1 (P0) added `workflows/brainstorm.yaml` and role
capabilities `brainstorm.idea-a`, `brainstorm.idea-b` and
`brainstorm.synthesis`, mapped to the existing Claude/Codex accounts by
profile patch (no new package, no mandatory verifier): one brief -> two
independent idea Artifacts -> one synthesis on the same Controller. B2 (P0)
was a credential-gated three-Worker run with cancellation, restart and
replay: ideas immutable, synthesis reading only their IDs, no completed call
repeated. B3 (P1) is at least 5 varied briefs against a single-Worker
baseline, recording costs, latency, novelty, diversity, usefulness and
operator feedback, not only exit 0. B4 (P1) reproduced concurrent same-Work
stress and repaired only demonstrated defects (no lost update, duplicate
dispatch or false replay success). B5 (P2), if demanded, adds one optional
capability through a config-enabled plugin: disable -> explicit refusal,
enable -> success, no controller edit or second plugin manager. **Later,
Website Research** (after the next MVP): a Website Worker/browser adapter,
source provenance and optional citation/claim verifiers, once a real
interactive or gated use case plus a fixture proves the need, with no
Research regression.

B0 and B4 are guardrails, not a reason to pre-empt B1 with refactors. Do not
block Brainstorm on a Website Worker, new UI, MCP, DSH Agent Team or advanced
verifier.

Output is `file@1` text Artifacts with attempt provenance; `succeeded` means
the declared steps produced their Artifacts, **not** that any idea is good or
correct. If explicit per-step Worker references are needed later, propose a
narrow, tested schema extension rather than hardcoding vendor names. Do not
assume the Codex account offers `research`.

## Decision: should we add another Worker?

**Recommendation: NO, not now.** The use case needs three role executions,
not three providers; more Workers add credentials, usage parsing,
maintenance and recovery surface without proving better brainstorms.
Consider one only if (1) a needed modality or capability is absent, (2) tests
show Claude/Codex cannot meet a quality, cost or availability need, (3) the
adapter implements the existing WorkerPort without changing the Controller,
and (4) an opt-in trial shows measurable improvement. A **Website Worker**
is the most plausible new modality, a later Research candidate.

## Components/plugins: use what exists first

Dispositions per component are in
[RES-0005](../research/RES-0005-plugin-reuse-audit.md). Keep `@system/work`,
`artifacts`, `agents`, `verifiers` (code and citation checks stay available,
claim verification is future) and `effects` (no auto-publishing of text);
reuse DSH/Cordis plugin config for role capabilities. Avoid a team/chat board,
a domain-specific controller, transcript sharing, a second store, a new
provider or DSH model loop, a duplicate plugin manager, a monolithic workflow,
peer messaging or a vote engine. Adapt System 1 ideas only when measured;
defer DSH Agent Teams and `dsh-jobs-local` (separate Session authority, jobs
are not durable Work) and `ctx.web` / Website Workers (a later Research
integration, never mandatory in Brainstorm).

## What counts as done?

**Brainstorm:** a human submits a brief and receives three immutable,
attributable outputs (two proposals, one synthesis) through the same
controller using Claude and Codex; run/retry/replay are inspectable; no claim
of formal answer quality. **Research:** the existing flow keeps working and
claim-level verification is not a blocker; when Website Worker research
becomes a goal, revisit evidence and verification in a new proposal/ADR with
measurements.
