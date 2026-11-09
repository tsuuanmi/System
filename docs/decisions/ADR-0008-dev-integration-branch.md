---
id: ADR-0008
type: decision
status: accepted
date: 2026-11-06
summary: System's own changes integrate into a `dev` branch that System may update and merge into once the required checks pass; only the operator merges `dev` into `main`.
related: [ADR-0004, ADR-0007]
---

# A `dev` integration branch System may merge into

## Context

[ADR-0004](ADR-0004-mvp-0-operating-decisions.md) decision 10 says System
never merges; merging stays a human action. Once System began changing
itself, every change of its own became a draft PR waiting for the operator,
even when the repository's required checks had passed on its exact commit.
The operator wants System's work to flow without waiting, and to keep the
decision about what reaches `main` for themselves.

## Decision

1. The repository has a long-lived **`dev`** branch. System's Software
   Engineering Work publishes against `dev`. It pushes `system/<work>` and
   opens a PR with base `dev`.
2. System **may merge into `dev`**, and only into `dev`, when all of these
   hold:
   - the required checks passed on the exact commit it published;
   - the PR's head is still that commit;
   - the merge is clean.
   The merge is an effect like the push. It records an intent before it acts
   and the outcome after, and an unknown outcome is reconciled by reading
   GitHub, never by merging blindly again. Any other target branch is
   refused.
3. **Only the operator merges `dev` into `main`.** No Worker, Orchestrator
   or System effect does it. This replaces "System never merges" in ADR-0004
   decision 10 for `dev`, and keeps it for every other branch.

## Clarification (2026-11-07)

"The required checks" in decision 2 means System's own verifier:
`code.required-checks` over `.system/checks.yaml`, passed on the exact commit.
System does **not** wait for GitHub's CI. GitHub branch protection, if
configured, can still refuse the merge (HTTP 405); that is recorded as
`failed` and not retried. A pull request for the `system/<work>` branch that
targets any other base is never merged or retargeted: the outcome is `failed`.

## Amendment (2026-11-07): a feature integration branch

The operator opened `web-workers` for the Website Worker programme, where
System develops Website Workers using Website Workers (PLAN milestone WW).
While it runs, `dev` takes no changes and the Host runs `web-workers`.

- `mergeInto` is `[dev, web-workers]`. System's Work for the programme
  publishes with base `web-workers` and may merge into it under decision 2's
  conditions, unchanged.
- **Only the operator merges `web-workers` into `dev`**, when milestone WW's
  gate holds. The base for System's Work goes back to `dev` with that merge.

## Amendment (2026-11-07): the merge queue

PROP-0007 decision 6, chosen by the operator over GitHub's merge endpoint.
Four changes that each passed their checks broke `dev` together, because each
was checked against a tip that had moved. Decision 2 now reads:

- System merges one change at a time per base, and **`dev` moves only to a
  commit whose required checks passed**: the change itself when it already
  holds `dev`'s tip, otherwise its merge with the tip, checked again with
  the same pinned criteria. A conflict fails the publish step, naming the
  files.
- `dev` moves by a push with a lease on the tip that was checked (bors' "not
  rocket science" rule, as GitHub's merge queue does). If `dev` moved
  meanwhile, the change is merged and checked again on the new tip. GitHub's
  merge endpoint is no longer used: it merges onto whatever the tip is then.
  GitHub marks the pull request merged when `dev` holds its head.
- A branch protection that requires pull requests refuses the push; the
  publish step then fails with that message. The outcome is reconciled by
  reading whether `dev` holds the change.

## Consequences

- System's verified changes reach `dev` without waiting. The operator
  reviews `dev` against `main` in batches.
- `dev` can hold changes the operator has not read. The required checks are
  what gate it, so their coverage (docs, unit, smoke) matters more. Gaps
  found there are fixed in the checks, not by reviewing each PR.
- The `git.publish` provider needs a merge step limited to an allowlist of
  target branches (`dev`). Until it exists, System's PRs into `dev` are
  opened and merged by the operator's agent after review.
