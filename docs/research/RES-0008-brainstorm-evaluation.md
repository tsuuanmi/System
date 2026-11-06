---
id: RES-0008
type: research
status: active
summary: Evaluate Brainstorm (PLAN.md B3) on five real briefs against a one-Worker baseline, with a stance per proposal and a Codex synthesis as variants; blind scores by a model judge.
related: [RES-0006, RES-0007, ADR-0002, ADR-0003]
---

# Brainstorm evaluation (B3): five briefs, three arms

**Run: 2026-11-06, on PR #2.** The configurations are in
[workflows/experiments](../../workflows/experiments/README.md). This is
evidence for a product choice, not a requirement.

## Method

Five open questions about System itself, one for each kind PLAN.md B3 asks
for: conversation-to-Artifact ingestion (*architecture*), whether to run
steps in parallel (*tradeoffs*), capturing operator judgements (*feature*),
what breaks with 20 concurrent Works (*failure*), and the next kind of
delegated work (*openended*). Each brief ran in three arms, all at
`tier.standard` (Claude Code `claude-sonnet-5-5`; Codex with `gpt-6.1-sol`
requested, since Codex does not report the model it served):

| Arm | Workflow | Attempts |
|---|---|---|
| S | `brainstorm-single`: one Claude attempt, the same sections | 1 |
| B | `brainstorm.yaml`: Claude and Codex share one prompt; Claude synthesises | 3 |
| R | `brainstorm-roles`: Claude as pragmatist, Codex as skeptic; Claude synthesises *architecture*, *tradeoffs* and *feature*, Codex *failure* and *openended* | 3 |

All 15 Works succeeded: 35 attempts, five hosts in parallel, and no operator
touches.

**Scoring.** The three final outputs of each brief were shuffled and labelled
X, Y and Z, and the key was kept apart. At the operator's request, a Claude
Sonnet subagent that saw only the blind packet scored each output from 1 to 5
on five criteria:

- usefulness for the decision (U);
- diversity of options (D);
- critical thinking (C);
- actionability (A);
- worth of its run time (W).

The scores, the key, the run list and the briefs are Artifacts in the
operator's store:

- scores `sha256:5fc55e82…`;
- key `sha256:170789e8…`;
- runs `sha256:b92a72e9…`;
- briefs `sha256:d5aa6945…`.

## Results

| Arm | Run time (mean) | Tokens in / out (mean) | U | D | C | A | W | Quality (mean of U, D, C, A) | Best of three |
|---|---|---|---|---|---|---|---|---|---|
| S | 37 s | 40k / 3.4k | 3.6 | 3.4 | 3.0 | 4.4 | 4.8 | **3.60** | 0 of 5 |
| B | 157 s | 164k / 10.0k | 5.0 | 3.8 | 4.8 | 5.0 | 3.2 | **4.65** | 2 of 5 |
| R | 162 s | 152k / 8.9k | 4.6 | 4.2 | 4.6 | 4.4 | 3.4 | **4.45** | 3 of 5 |

By brief (sum of U, D, C and A, at most 20):

| Brief | S | B | R | Best |
|---|---|---|---|---|
| architecture | 15 | 19 | **20** | R |
| tradeoffs | 13 | 18 | 18 | R |
| feature | 13 | 18 | **20** | R |
| failure | 15 | **19** | 16 (Codex synthesis) | B |
| openended | 16 | **19** | 15 (Codex synthesis) | B |

The two proposals were also compared by word cosine (lower means more
different). With a stance per proposal (R) they were more different in three
of five briefs: mean 0.46 against 0.50 for B.

## Findings

1. **Brainstorm beat the baseline on every brief.** It scored about one
   point higher on usefulness, critical thinking and diversity, for about four
   times the time and tokens. The judge's summary: the synthesised answers
   "paid off most where the problem had hidden correctness or protocol traps".
   The single answer was good value on narrower briefs, and only S scored
   high on worth (W).
2. **A stance per proposal helped, but only with the Claude synthesis.**
   Where Claude synthesised, R scored at least as well as B on all three
   briefs and was best on all three. Where Codex synthesised, R fell below B,
   and its *failure* summary was judged "dense, hedged and abstract".
3. **The synthesis provider confounds the stance effect.** The Codex
   synthesis was tried only together with stances, on two briefs. The effect
   of the synthesiser is therefore not separated from the effect of the
   stances.

## Limits

- **The judge is a model, not the operator.** PLAN.md B3 says model scoring is
  not enough evidence on its own.
- **The judge may favour its own model.** The judge is Sonnet, and Sonnet
  also wrote S, every proposal A and every Claude synthesis. The low scores of
  the Codex syntheses may partly reflect this.
- **The sample is small:** five briefs, one run per arm, and no repeats to
  measure variance.
- **Every brief is about System itself,** so the results may not carry over
  to other domains.

## Recommendation

- **Keep Brainstorm, and use it for decisions where blind spots are
  expensive.** Use one Worker for narrow questions.
- **Try stances in `brainstorm.yaml` with Claude as the synthesiser.** Change
  the default only after the operator confirms the result on a few real uses.
  *Adopted:* the operator made the stances the default (PLAN.md milestone P);
  `brainstorm-shared.yaml` is the one-shared-prompt arm B, and arm R is now
  `brainstorm.yaml` version 2.
- **Do not move the synthesis to Codex yet.** First run one clean comparison
  (B with a Codex synthesis) and have it scored by a judge that is not Sonnet,
  or by the operator.
- **Do not add debate or voting.** Nothing observed calls for them.
