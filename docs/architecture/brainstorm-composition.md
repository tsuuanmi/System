---
type: architecture
status: active
reviewed: 2026-11-06
---

# Brainstorm as a Workflow composition, not a Team engine

**Architecture semantics selected by [ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md)
and [ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md).**
The implementation evidence described here is from **stacked draft
[PR #2](https://github.com/tsuuanmi/System/pull/2)** at
[`4a71c79`](https://github.com/tsuuanmi/System/commit/4a71c79f5fc9ed4857bd027625eda8b56f854bb8);
it is **not merged into this documentation-only PR #1 or main**.

## Current capability and shape

```text
                   Work input: brief Artifact ID
                         /              \
       idea-a (Claude)                       idea-b (Codex)
             |                                    |
     proposal Artifact ID A               proposal Artifact ID B
                         \              /
                   synthesis (Claude)
                            |
                    summary Artifact ID
```

This diagram denotes **data dependencies**, not simultaneous dispatch.
Current [WorkController](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/packages/work/src/controller.ts)
advances **one ready step at a time**, in a stable order. Independent
`idea-a` and `idea-b` receive **only the same brief Artifact ID**,
not each other's output; `synthesis` depends on both and receives
both exact proposal IDs and the brief. The current
[Workflow YAML](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/workflows/brainstorm.yaml)
is the executable source of its step graph and prompts. Do **not** copy
the Workflow graph into TypeScript or create a standalone Brainstorm engine.

Three *Worker attempts* do not mean three provider implementations or
independently running agent sessions. The DSH
[bundle account configuration](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/packages/bundle/cordis.patch.yml)
maps `brainstorm.idea-a` to Claude Code, `brainstorm.idea-b` to Codex,
and `brainstorm.synthesis` to Claude Code. The
[registry](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/packages/work/src/registry.ts)
selects the first capable account and fails preflight when a required
capability is missing. Configurable role labels are an **initial routing
policy**, not a new class of Worker.

## Handoff, status and model provenance

1. Admission pins the resolved Workflow spec by Artifact ID. Later edits to
   the YAML do not affect already admitted Work.
2. Each proposal is an immutable, separately attributable Artifact,
   with Work ID, attempt ID and executor details. The synthesis receives
   exact input IDs, not copied model conversations.
3. Completed proposal steps are retained on cancellation/retry. Replay
   compares persisted events/state; **it never calls the LLM again**.
4. A Workflow with no verifier/accept step can finish as `succeeded`
   after all its required Worker steps succeed. In **Brainstorm**, this
   denotes **successful artifact delivery**. It does **not** mean ideas
   were fact-checked, endorsed, adopted or experimentally validated.
5. Record **requested model** and **reported served model** separately.
   The real B2 demonstration observed Claude Haiku and a Codex account
   with the requested `gpt-6-luna`; Codex did **not** disclose its
   actual served model. Do not infer it from the requested tier.
6. Absence of a required second provider must be an explicit admission
   refusal, not an unnoticed fallback to two Claude attempts.

The live run, source-backed tests and limits are catalogued in
[RES-0007](../research/RES-0007-brainstorm-and-concurrency-review.md).

## B3 product experiment: quality is not a verifier gate

The next task is to test whether the **three-attempt** configuration helps
an operator more than **one Worker**. Use at least five distinct briefs
(architecture, trade-off, feature proposal, failure diagnosis, open-ended
ideation), compare against a one-Worker baseline, and collect human
judgments of usefulness, diversity, disagreement quality, actionability,
time, known usage and interventions.

A **config-only** alternative was tested and adopted as the default:
distinct cognitive roles. One proposal (`idea-a`) optimizes simplicity and
practical feasibility while the other (`idea-b`) looks for missing
assumptions and disconfirming cases. The one-shared-prompt version is kept
as `workflows/experiments/brainstorm-shared.yaml`.
Both still receive only the original brief, and the prompts should not
script fake disagreements. Keep both proposals visible beside the
synthesis so the operator can disagree with the synthesizer. Test a
Codex synthesis on a subset as a sensitivity check; do **not** require
an additional Worker provider or mandatory model verifier.

## What stays outside this boundary

- No System 1 Team/session persistence, voting, ballots, debate engine,
  consensus-as-truth or third model provider for Brainstorm V0.
- No mandatory parallel scheduling: parallel fan-out needs a separately
  tested same-Work ownership and event-ordering design.
- Website Worker, import of external web conversations and source
  provenance are **later capabilities**, using the same Artifact/Worker
  contracts rather than replacing this Workflow.
- Research claim verification is future work; existing configured verifiers
  remain available but do not become mandatory for exploratory Brainstorm.

See [Workflow composition](workflow-composition.md),
[Artifact contracts](artifact-verification.md),
[draft runtime integrity boundary](work-ownership-and-recovery.md) and
[draft roadmap](../proposals/PROP-0002-post-mvp-roadmap.md).
