---
type: architecture
status: active
reviewed: 2026-11-06
decided-by: [ADR-0002, ADR-0003]
covers: [workflows/brainstorm.yaml]
---

# Brainstorm as a Workflow composition, not a Team engine

**Semantics selected by [ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md)
and [ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md).**

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

This diagram denotes **data dependencies**. The Host runs the two ideas at
once, on different Accounts ([Host](host.md#attempts-and-slots)). Independent
`idea-a` and `idea-b` receive **only the same brief Artifact ID**,
not each other's output; `synthesis` depends on both and receives
both exact proposal IDs and the brief. The current
[Workflow YAML](../../workflows/brainstorm.yaml)
is the executable source of its step graph and prompts. Do **not** copy
the Workflow graph into TypeScript or create a standalone Brainstorm engine.

Three *Worker attempts* do not mean three provider implementations or
independently running agent sessions. The DSH
[bundle account configuration](../../packages/bundle/cordis.patch.yml)
maps `brainstorm.idea-a` to Claude Code, `brainstorm.idea-b` to Codex,
and `brainstorm.synthesis` to Claude Code. The
[registry](../../packages/work/src/registry.ts)
selects the capable account with a free slot and the most quota headroom, and fails preflight when a required
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

The live run was evaluated in RES-0008 ([retired](../governance/retired.md); the findings are below).

## B3 product experiment: quality is not a verifier gate

The question is whether the **three-attempt** configuration helps an operator
more than **one Worker**: at least five distinct briefs (architecture,
trade-off, feature proposal, failure diagnosis, open-ended ideation), a
one-Worker baseline, and human judgments of usefulness, diversity,
disagreement quality, actionability, time, known usage and interventions
(results below).

**Result (RES-0008, 2026-11-06, five briefs, scored blind by a Claude Sonnet judge, which may favour its own
model).** Brainstorm beat one Worker on every brief (quality 4.65 shared prompt and 4.45 with stances, against 3.60)
for about four times the time and tokens; use one Worker for narrow questions. Stances helped only with a Claude
synthesis, and the synthesis provider is confounded with them. Do not move the synthesis to Codex before one clean
comparison judged by someone other than Sonnet, and add no debate or voting.

The config-only **distinct cognitive roles** variant was tested and adopted
as the default: `idea-a` optimizes simplicity and practical feasibility,
`idea-b` looks for missing assumptions and disconfirming cases.
Both still receive only the original brief, and prompts should not script
fake disagreements. Keep both proposals visible beside the synthesis so the
operator can disagree with the synthesizer, and test a Codex synthesis on a
subset as a sensitivity check; do **not** require another Worker provider or
a mandatory model verifier.

## What stays outside this boundary

- No System 1 Team/session persistence, voting, ballots, debate engine,
  consensus-as-truth or third model provider for Brainstorm V0.
- The Website Worker ([`packages/web-worker`](../../packages/web-worker/README.md), off by default) is built; it
  and any import of external web conversations or source provenance use the same Artifact/Worker
  contracts rather than replacing this Workflow.
- Research claim verification is future work; existing configured verifiers
  remain available but do not become mandatory for exploratory Brainstorm.

See [Workflow composition](workflow-composition.md),
[Artifact contracts](artifact-verification.md),
[runtime integrity boundary](host.md#crash-and-recovery-invariants) and
[PLAN.md](../../PLAN.md).
