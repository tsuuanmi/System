---
id: ADR-0010
type: decision
status: accepted
date: 2026-11-07
summary: The active core's growth budget is measured from 3,403 lines (after milestone OC) instead of the PR #3 baseline of 2,317, at +10% per milestone, and growth over it is paid back within the same milestone; removing features to shrink the core is planned separately.
related: [ADR-0007, ADR-0009]
---

# The core budget, measured from OC

## Context

The [Charter](../requirements/purpose.md#philosophy) (item 11) asks System to
stay changeable, and PLAN keeps a growth budget for the active core
(`packages/work/src` and `packages/artifacts/src`): +20% per milestone over
the PR #3 baseline of 2,317 lines. Since then the Host (ADR-0007), Goals and
Orchestrators (ADR-0009) and milestone OC (PROP-0006) made it 3,403 lines,
+46.9%. Each milestone recorded the overage as an open debt, and the
simplification passes paid back little: the growth is behaviour, not
duplication. Getting back under +20% would mean cutting about 620 lines,
that is, dropping a feature as large as the Goals or the slots.

## Decision

1. The core budget is measured from **3,403 lines**, the core after
   milestone OC (operator, 2026-11-07).
2. The budget is **+10% per milestone** over the core at the start of that
   milestone. Growth above it is paid back by removal within the same
   milestone; it is no longer carried as debt.
3. Shrinking the core by dropping features is planned on its own (PLAN, "Core
   debt"): a System Work proposes cuts with their line counts, the operator
   decides each, and each cut is its own pull request.

## Consequences

- A debt that was never going to be paid stops hiding as a number; a budget
  overrun becomes a decision inside the milestone that caused it.
- The old measures stay in PLAN's growth table as history.
- Rejected: keeping the old baseline and cutting 620 lines now (it drops
  working features for a number), and keeping it without enforcing it (the
  budget then means nothing).
