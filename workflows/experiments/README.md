# Workflow experiments

Configurations for the Brainstorm evaluation (PLAN.md B3). They are not
product Workflows. They exist so that the comparisons can be rerun.

- [brainstorm-single.yaml](brainstorm-single.yaml): the baseline, one
  Claude Code attempt that writes the sections a Brainstorm summary has.
- [brainstorm-shared.yaml](brainstorm-shared.yaml): the comparison arm,
  [../brainstorm.yaml](../brainstorm.yaml) with one shared prompt for both
  proposals instead of a stance each (pragmatist, skeptic).
- [codex-synthesis.patch.yml](codex-synthesis.patch.yml): a profile overlay
  that moves `brainstorm.synthesis` to Codex
  (`bin/system --patch <file> work submit ...`). It copies the bundle's
  `agents` row; keep the two in step.

The tests in [workflow.test.ts](../../packages/work/tests/workflow.test.ts)
check that these files resolve.
