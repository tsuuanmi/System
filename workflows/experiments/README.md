# Workflow experiments

Configurations for the Brainstorm evaluation (PLAN.md B3) and Workflows that
are not canonical (ss-6). They are not product Workflows. They exist so that
the comparisons can be rerun.

- [brainstorm-single.yaml](brainstorm-single.yaml): the baseline, one
  Claude Code attempt that writes the sections a Brainstorm summary has.
- [brainstorm-shared.yaml](brainstorm-shared.yaml): the comparison arm,
  [../brainstorm.yaml](../brainstorm.yaml) with one shared prompt for both
  proposals instead of a stance each (pragmatist, skeptic).
- [codex-synthesis.patch.yml](codex-synthesis.patch.yml): a profile overlay
  that moves `brainstorm.synthesis` to Codex
  (`bin/system --patch <file> work submit ...`). It copies the bundle's
  `agents` row; keep the two in step.
- [second-opinion.yaml](second-opinion.yaml): one independent Worker
  (`review.second-opinion`) reviews a change or a document and writes a
  `review`. No verifier.
- [debate.yaml](debate.yaml) — a Debate of two Rounds: `a1` and `b1` write a
  `proposal` each from the brief alone (the Brainstorm stances); in Round 2 `a2`
  and `b2` read both proposals and write a `rebuttal` with a revised proposal,
  on the same capabilities, so each side keeps its Account; `synthesis` reads
  all four Artifacts and writes a `summary`. No verifier.
- [research-fanout.yaml](research-fanout.yaml) — `plan` (`research.plan`) splits the
  question into `question-a` and `question-b`; two Lanes, `investigate-a`
  (`research.lane-a`) and `investigate-b` (`research.lane-b`), each run the
  [research.yaml](../research.yaml) investigation (shared by a YAML anchor) and have their `sources`
  checked; `synthesis` (`research.synthesis`) merges both into one `report` and
  `sources`, checked again. A profile gives each Lane to a different Account. Each Lane
  asks `tier.standard`, like `research.yaml`.

The tests in [workflow.test.ts](../../packages/work/tests/workflow.test.ts)
check that these files resolve.
