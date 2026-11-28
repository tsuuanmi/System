---
id: ADR-0019
type: decision
status: accepted
date: 2026-11-28
summary: A Release is cut at one commit of `dev` on a `release/<commit>` branch, its report is generated from records by `system release prepare`, the Operator may approve that exact commit so a caller session merges and installs it, and docs waivers travel as `Docs-Unchanged:` git trailers of the commits instead of a file cleared at each release.
related: [ADR-0008, ADR-0016, ADR-0015]
---

# A Release is cut at a commit

Accepted 2026-11-28 by the operator in a grilling session ("Đồng ý toàn bộ việc", questions Q1 to Q5 on the release
process). Acceptance does not mean the code follows it yet: the moves are Items rel-1 to rel-3.

## Context

Measured on the release of 2026-11-27/28 (pull request #560, merged as `0c80dc29`):

- The pull request went from `dev` itself, so every Work merged meanwhile moved its head: its range grew from 27 to
  56 commits in a day and CI ran again each time.
- `.system/docs-waivers` must be emptied in the release pull request, and every later Work that waives a doc adds a
  line again, so `docs` turned red after each clearing (plug-15's two lines). waiver-1 had to add `merge=union` and
  `--attr-source` only so two Works could both add a line.
- A release that touches `packages/verifiers/src`, `packages/effects/src` or `workflows/*.yaml` is not delegated, and
  almost every range touches one: fixes already on `dev` (night-node-1, agynode-1) waited a night for the Operator.
  The Operator then authorised the release in chat, which System cannot see.
- GLOSSARY said "The operator merging `dev` into `main`", while PLAN's "Release delegated" lets a caller do it.

## Decision

1. **A release is cut at one commit.** `release/<short commit>` is a branch at a chosen commit of `dev`; the release
   pull request goes from it into `main`, so its head does not move while `dev` keeps taking Works (git's release
   branch).
2. **The report is generated.** `system release prepare <commit>` creates the branch and writes the pull request body
   from records: the Works and Items in the range with their Accounts and costs, the Escaped defects, the
   `Docs-Unchanged:` trailers, the non-delegated paths the range touches, and "How to revert" with the commit the
   install runs. It prepares; it never merges.
3. **The Operator approves a release commit.** `system release approve <commit>` is an operation of the Operator's
   Authority (operator socket, terminal confirmation, as `system approve`); it stores an Artifact bound to that commit.
   A caller session may then merge that commit's release pull request and run `system update`, also when the range
   touches non-delegated paths; another commit needs its own approval. `relgate-1`'s report does not list an approved
   release.
4. **Waivers are commit trailers.** A Work that leaves a covered doc unchanged writes
   `Docs-Unchanged: <path> — <reason>` as a trailer of its commit (`git interpret-trailers`); the `docs` check of a
   Work and the docs CI of a release read the trailers of the range. `.system/docs-waivers`, its `merge=union`
   attribute, `--attr-source` in the publish's merge and `tools/check-docs-waivers.py` are deleted.
5. **GLOSSARY's Release** is "merging one commit of `dev` into `main` and installing it, after the Operator read its
   release report or approved that commit; System prepares a Release but never decides one".

## Alternatives considered

- **Keep the pull request from `dev` and freeze merges during a release:** rejected, it stops every Worker.
- **Clear waivers automatically in the release branch:** keeps the file and its merge workarounds.
- **Delegate every release:** rejected, verifier and effect code takes effect only at a release (PLAN ID).

## Consequences

- rel-1 (branch and generated report), rel-2 (the approval operation) and rel-3 (trailers) are Items; rel-3 edits
  `.system/checks.yaml`, `workflows/*.yaml` and `packages/effects/src`, so it is held for the Operator and released by
  them or under rel-2's approval.
- docs/operations/releases.md changes with each of them.
