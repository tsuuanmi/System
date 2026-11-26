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
