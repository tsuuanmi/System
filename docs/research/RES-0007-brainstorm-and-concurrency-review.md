---
id: RES-0007
type: research
status: active
summary: Review PR #2 Brainstorm B0-B2 and SQLite startup patch; isolate source-derived Work-lock hypotheses, B3 evaluations and future Website conversation provenance.
related: [RES-0005, RES-0006, ADR-0002, ADR-0003, ADR-0004]
---

# PR #2 source review: Brainstorm, concurrency and next evaluation

**Snapshot: 2026-11-06.** Sources examined from
[`tsuuanmi/System` PR #2 at `4a71c79`](https://github.com/tsuuanmi/System/commit/4a71c79f5fc9ed4857bd027625eda8b56f854bb8),
still a **draft, stacked PR** on documentation PR #1. This is a **read-only
source/CI review**, not a re-execution of the operator's local credentialed
Claude/Codex runs. The reference System 1 continues to be an external
audit source only.

## Confirmed from source and CI

- [`brainstorm.yaml`](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/workflows/brainstorm.yaml)
  is a three-step declarative config. Two proposals have the same brief
  input and no dependency on one another; synthesis depends on and reads
  both proposal Artifact IDs. No required verifier/accept stage.
- [`brainstorm.test.ts`](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/tests/brainstorm.test.ts)
  asserts Claude/Codex role routing, three attempts, exact input refs,
  producer provenance, missing-Codex refusal, cancellation and retry
  reusing proposal A, pinned spec despite file edits, and replay.
- The Work Controller remained one domain-independent, **sequential**
  interpreter at that commit; no Agent Team, third Worker implementation or
  mandatory brainstorm verifier was added.
- [`c9fc13b` pnpm patch](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/patches/@deepseek-ai__dsh-storage-sqlite@0.2.2-rc.1.patch)
  configures SQLite busy timeout, retries WAL journal mode under
  startup contention, and uses `INSERT OR IGNORE` with read-back for
  concurrent unit stamping. [`tests/concurrency.test.ts`](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/tests/concurrency.test.ts)
  checks simultaneous Artifact puts and `doctor` calls, including
  concurrent **fresh store creation**. It is **not** same-Work scheduling
  or lost-update coverage.
- **GitHub Actions at `4a71c79`:** Build and Documentation completed
  successfully. [PR #2 description](https://github.com/tsuuanmi/System/pull/2)
  reports 115/115 unit tests and 40/42 smoke tests (2 skipped because
  credentials are needed); operator-run real-agent tests report 2/2 pass.

## Reported by the operator, not independently rerun here

- Real Work `work:cad623e9-4a65-45ab-bb2d-eb473044811d` used
  Claude Haiku for proposal A, Codex for proposal B and Claude Haiku for
  synthesis. Total 127 seconds, 0 operator touches, `work replay` matches.
- The synthesis identified **six material disagreements** and suggested
  evidence to arbitrate them. This is qualitative output, not an
  established gain over a one-Worker baseline.
- Codex's model identifier `gpt-6-luna` was **requested**;
  the actual served model was not reported by the Codex CLI in that
  observed run. Never re-label a requested model as independently verified.

## Follow-up: PR #2 after the initial review

The table below is a **historical audit of `4a71c79`**, not a claim that the original defects remain unresolved.

- [`ccc5dd5`](https://github.com/tsuuanmi/System/commit/ccc5dd56390f3b6d54f7f58291f8fb77cac573e5) fixes the PID-lock publication gap: the lock is prepared with a PID before atomic publication; a regression test first reproduced the failure. [`40c6815`](https://github.com/tsuuanmi/System/commit/40c681507080bccdac7c45342f4b85f9c22586f5) records B4 completion, including a killed host plus four competing `work run` commands, one resumed attempt, ordered event IDs and matching replay. These are local-worker results read from source/PLAN, not tests re-executed in this audit.
- [`6dc0244`](https://github.com/tsuuanmi/System/commit/6dc0244f37e7b5505f9df2da875daedee2cb1030) adds single-Worker and stance-prompt comparison arms. [`973cea6`](https://github.com/tsuuanmi/System/commit/973cea6c9e00359519569e3b43a7f809215e518f) records **15 successful Works, five briefs and three arms**. Mean observed durations were **37 s** for single-Worker, **157 s** for three-attempt baseline and **162 s** for cognitive-role variant, with zero operator interventions. Reported proposal word-cosine similarity was 0.50 vs 0.46: lower lexical overlap is **not proof of better decision quality**.
- **B3 blind operator scoring remains outstanding.** Quality and value relative to the approximately fourfold elapsed-time overhead are not proven yet. No new Worker provider or Team engine should be selected on the basis of lexical diversity alone.

## Unverified risks and proposed test gates

| Finding | Evidence | Confidence / next proof |
|---|---|---|
| Incomplete PID lock is stealable | [`FileControl.acquire()`](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/packages/work/src/control.ts) creates empty lock via `openSync('wx')`, writes PID later; `holder()` returns undefined on empty content and stale cleanup can move/remove the path | **Source-derived P1 hypothesis**: deterministically pause between create/write while a second process acquires. Prove one owner before fixing. |
| Reopen/run is not one lock interval | [`WorkController.retry()`](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/packages/work/src/controller.ts) releases lock after `reopened`, then calls `run` | **Possible race**: test concurrent retry/run/cancel event ordering and no duplicate Worker dispatch. |
| Patch solves lock waiting, not Work ownership | [SQLite patch](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/patches/README.md) and [concurrency test](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/tests/concurrency.test.ts) | **Confirmed test-scope limitation**: add same-Work concurrency, stale lock and effect reconciliation fixtures. |
| Model diversity is not measured quality | Two providers; the current YAML reuses one proposer prompt via YAML anchor | **Product question**: compare one Worker against independent proposal synthesis and role-diverse prompts across five briefs, with operator assessment. |
| Web conversation handoff is not yet Artifact-backed | Operator's web brainstorming and research were copied into PR docs manually, unlike Work artifacts produced in System | **Valid workflow gap, not proof browser automation is necessary**: first compare explicit conversation-to-Artifact import with Website Worker implementation when scoped. |

## B3 experiment and boundary

The B3 method (at least five varied briefs, a single-Worker comparator,
operator-judged usefulness, diversity, disagreement and next-action quality,
plus time, usage, interventions and summary bias; models do not rate
themselves) is in [Brainstorm composition](../architecture/brainstorm-composition.md#b3-product-experiment-quality-is-not-a-verifier-gate).
A different-cognitive-role pair and an alternating synthesis provider are
useful second variants.

Keep the existing components and two providers; no System 1 voting or Team
sessions, no third provider to fill three roles. A provenance-only
conversation-to-Artifact import may deserve a small spike before a
browser-driven Website Worker, which can follow for interactive or
authenticated sources and must still produce exact Artifact IDs. Claim-level
Research verification and mandatory isolation are not near-term gates.

Architecture ownership: [Brainstorm composition](../architecture/brainstorm-composition.md),
[Work integrity design](../architecture/work-ownership-and-recovery.md).
Priorities: [PROP-0002](../proposals/PROP-0002-post-mvp-roadmap.md).
