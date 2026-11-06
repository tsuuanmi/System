# Workflow experiments

Configurations for the Brainstorm evaluation (PLAN.md B3). They are not
product Workflows. They exist so that the comparisons can be rerun.

- [brainstorm-single.yaml](brainstorm-single.yaml): the baseline, one
  Claude Code attempt that writes the sections a Brainstorm summary has.
- [brainstorm-roles.yaml](brainstorm-roles.yaml):
  [../brainstorm.yaml](../brainstorm.yaml) with a different stance for each
  proposal (pragmatist, skeptic) instead of one shared prompt.
- [codex-synthesis.patch.yml](codex-synthesis.patch.yml): a profile overlay
  that moves `brainstorm.synthesis` to Codex
  (`bin/system --patch <file> work submit ...`). It copies the bundle's
  `agents` row; keep the two in step.

The tests in [workflow.test.ts](../../packages/work/tests/workflow.test.ts)
check that both files resolve.
