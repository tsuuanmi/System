# Workflow experiments

Workflows that are not canonical (ss-6). They are not product Workflows.

- [second-opinion.yaml](second-opinion.yaml): one independent Worker
  (`review.second-opinion`) reviews a change or a document and writes a
  `review`. No verifier.

- [review-replay.yaml](review-replay.yaml): rev-1, a read-only `tier.frontier`
  step that reviews a diff given as the Task's context against the base's
  `REVIEW.md` and writes `findings` with severity. A measurement, never a
  gate; replays are recorded in [RES-0019](../../docs/research/RES-0019-model-review-replay.md).

The tests in [workflow.test.ts](../../packages/work/tests/workflow.test.ts)
check that these files resolve.
