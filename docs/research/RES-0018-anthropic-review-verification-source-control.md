---
id: RES-0018
type: research
status: active
summary: Three Anthropic posts of 2026-10 and 2026-11 on code review, verification and source control at agent scale, read against System's records of 2026-11-26; what they change in the decisions on smoke, the merge queue, gates that need a person and model review.
related: [RES-0016, RES-0017, ADR-0011, ADR-0014]
---

# Review, verification and source control at Anthropic, against System

**Research as of 2026-11-26; evidence for a decision, not the decision.** The operator asked which direction suits
System
after reading three posts; the decisions they settled are the Intent
`sha256:0e0a2c42aa37213102fb97784218e6f4346022a03ccafa24d396b7d1552a82d8` and its Items in [STATUS.md](../../STATUS.md).
Each post was read by a page reader; its figures are Anthropic's own, not independently checked.

## The posts

- [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic) (2026-10-15).
  Gates in order: the agent runs tests, build and lint and a fresh-context subagent reviews the diff; required CI
  blocks;
  an AI review on every PR (finders in parallel, verifiers vote) and a security pass block on open findings; human
  approval is tiered by a classifier on the change (low risk none once green, medium one, high two; some paths such as
  CI workflow files always need a person); a merge queue re-runs checks on the latest main. "An agent's approval never
  counts as a person's", and an approval covers one commit. Review rounds are capped at three after a PR went through
  more than fifty.
- [How the Claude Code team thinks about
  verification](https://claude.dev/blog/how-the-claude-code-team-thinks-about-verification)
  (2026-11-16). End-to-end runs are how "nearly all changes" are tested; heavy tests belong before the commit; slow
  tests
  make agents run fewer of them. "Changes can't modify their own checks." A flaky test may not be skipped, slept or
  retried: without a root cause it is deleted and the reason written down.
- [Redesigning source control](https://www.anthropic.com/research/redesigning-source-control) (2026-10-13). At about
  30,000 merges a day a global serialized merge queue stopped making sense; Anthropic moved to post-merge and pre-deploy
  testing and lets Claude fix conflicts. It offers nothing on conflicts in shared prose files.

**Corrections, 2026-11-27** (the three posts were fetched again in full; each quote below was found in the fetched
text):

- *Merge queue.* "Dropped" in the table below overstates the post. It says "We haven't been able to effectively
  replicate the industry standard of a global repository lock on the merge queue", and it still names an "Antique merge
  queue superfan"; what went is the global lock, not a queue. The post also says its system is not a "suitable
  replacement for git" for general use. The direction for System (one change at a time) is unchanged.
- *Model review.* "Blocking" holds for the security pass only: the review product "posts findings, not approvals".
  The post also admits "We don't yet have circuit breakers" that tighten approval when reverts rise, and light review
  paths are for a trusted-author list only ("Everyone else needs a second person"); System has no author trust and
  needs none with one operator.
- *Verification.* Not in the lifecycle below: property tests (fast-check, Hypothesis) and differential tests ("the old
  system is the oracle"), which the post offers against the agent's own bias; PLAN section 0 keeps them waiting for an
  Escaped defect of their kind.

## Against System's records

| Topic | Anthropic | System on 2026-11-26 | Direction |
|---|---|---|---|
| End-to-end checks | on nearly every change | smoke on every code Work, median 105 s | keep it on every Work; make it faster |
| Merge queue | dropped at about 30,000 a day | about 30 a day, publish median 0.3 min | keep one change at a time |
| Paths that need a person | CI files and other sensitive paths | none; a Worker can change `.system/checks.yaml` used by later Works | hold such changes for an Approval |
| Approval bound to a commit; agents never approve | yes | yes (Verifier bound to an Artifact, ADR-0011) | unchanged |
| Model review | blocking, voted, round-capped | none (PLAN section 4 trigger: an Escaped defect a diff review would catch) | the trigger has likely fired (st-1, ag-2); measure on replay first |
| Flaky tests | delete with a reason when no root cause | fix as a defect (Charter 12) | add the documented deletion |

Checks per Work on 2026-11-26 (29 merged Works): median 3.7 min, p90 14.3 min; smoke 52 minutes of the day, build 23,
unit 17, web 9 (three runs; it is already limited by path). A Work's checks run in order in one worktree so that
install and build are shared, so running them in parallel needs care.

## The lifecycle of one change

None of the three posts describes one lifecycle end to end; this is assembled from all three and is not Anthropic's
own diagram. In order: decide to build (a person; not recorded) → the agent writes, guided by CLAUDE.md → it runs
tests, build, lint and an end-to-end `verify` skill before the commit, a fresh-context subagent reviews the diff, and
it must "show the output" → the commit is stamped with how it was verified (which can be "none"; gate modes off,
observe, enforce; after two blocks in a session the next commit passes) → a PR template with Testing, Risk and How to
revert → required CI → parallel bug-hunting review with verifier voting, findings tagged Important, Nit or
Pre-existing, every finding answered; after three rounds the reviewer asks to reconsider the approach, and a check
still failing after three rounds brings in a person → a separate security review → a risk tier set by the change (low:
no person; medium: one; high: two; sensitive paths and CI files always a person; an agent's approval never counts; an
approval binds one commit) → a merge queue against the latest main → flags, internal use first → `latest`, then
`stable` → watch, revert, on-call, with bisect and revert through source-control APIs → each revert or incident
becomes an eval case. New review rules need two PRs, a diff a person can read, three agents trying to disprove them
and a human-approved PR; rules are pruned. REVIEW.md is read from the base branch. At more than 30,000 changes a day a
merge is a compare-and-swap on one ref with no global lock, tests run after merge and before deploy, and Claude fixes
conflicts; "a proper merge queue doesn't make much sense at agent scale".

| Anthropic stage | System's |
|---|---|
| decide to build (not recorded) | Intent: System records it; Anthropic does not |
| agent writes with CLAUDE.md | Task context pack |
| agent runs checks, "show the output" | Host-run checks: System does not take the Worker's word |
| approval binds one commit | Verdict bound to an Artifact |
| changes can't modify their checks | checks and gates read from the base (gate-1) |
| three rounds, then a person | reopen cap (develop.yaml `retry max: 1`, then fail) |
| AI review, voted | Model check in shadow (rev-1) |
| low tier: no person | auto-merge into dev, a person at release |
| high tier and sensitive paths | gate-1 |
| merge queue (dropped at scale) | kept: RES-0018's own decision, because of scale |
| `latest` then `stable` | dev and main, the `system update` rehearsal and afterInstall |
| revert and incident | Escaped defect; no revert path yet ([revert-1](../../STATUS.md)) |
| eval case from each miss | Guardrail; no eval set yet ([evalset-1](../../STATUS.md)) |
| flaky tests deleted with a reason | flaky-pol-1 |

Principles, as quoted: "Everything is reversible", "Blast radius sets the bar", "The change sets the tier, not the
author", "Whoever prompted the change is on the hook for it", "Review has to converge". Anthropic's measures: merged
PRs doubled from June to September, reverts fell by more than 40%, and review rounds to pass fell from 2.08 to 1.32.

**Conclusion.** Human attention is allocated by risk, and safety comes from reversibility as much as from gates.
System's gaps are a release revert path ([revert-1](../../STATUS.md)), an eval set of misses
([evalset-1](../../STATUS.md)) and measured rounds ([rounds-1](../../STATUS.md)); they are Items under Intent
`sha256:25a45ced0d2aaab001a43701a50208d288625dd5d0eb0bb4b3f0e18a83169b64`.
