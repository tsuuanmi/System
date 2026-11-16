# Workflow experiments

Workflows that are not canonical (ss-6). They are not product Workflows.

- [second-opinion.yaml](second-opinion.yaml): one independent Worker
  (`review.second-opinion`) reviews a change or a document and writes a
  `review`. No verifier.

The tests in [workflow.test.ts](../../packages/work/tests/workflow.test.ts)
check that this file resolves.
