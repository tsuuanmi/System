---
id: ADR-0014
type: decision
status: accepted
date: 2026-11-20
summary: A check may name the events it runs on with GitHub Actions' on, so the heavy checks (upgrade, install-guide) run once per release instead of once per Work; accepted trade-off - a defect only those checks catch can reach dev, and system update still refuses a release whose checks fail.
related: [ADR-0003, ADR-0008]
---

# Checks in tiers by event

Accepted 2026-11-20 by the operator (Intent 469fd00fd3dd, settled in a caller
session; Items ct-1 to ct-3 in STATUS.md carry it out).

## Context

- Every Work ran the full `.system/checks.yaml` about twice: the checks step,
  and the merge re-check when `dev` had moved, which is nearly always with
  several Workers.
- A System suite takes about 7 min. Median of about 120 recent Works:
  upgrade 209 s, smoke 96 s, unit 43 s, build 33 s, install-guide 55 s,
  web 182 s (path-limited).
- Under host load (load average about 274 on 256 cores on 2026-11-20, mostly
  other users) checks timed out or were classed `load`/`slow-host`.
- Raising Worker slots multiplies that.

## Decision

1. A check may name its events with GitHub Actions' `on:` and event names:
   - `pull_request`: a Work's checks step;
   - `merge_group`: the merge re-check into `dev`;
   - `release`: `system update`'s check of a `main` commit.

   Without `on:` a check runs on every event.
2. The System repository's tiers:

   | Events | Checks |
   | --- | --- |
   | `pull_request`, `merge_group`, `release` | docs, statusmd, install, build, typecheck, unit |
   | `pull_request`, `release` | secrets, lint, smoke, web |
   | `release` only | upgrade, install-guide |

3. Standards considered: GitHub Actions `on:` (adopted), GitLab `rules:`, and
   the bors/GitHub merge-queue batching that ct-3 follows.

## Trade-off, accepted by the operator

| | Before | After |
| --- | --- | --- |
| Time per Work (checks step + merge re-check) | about 7 + 7 min | about 3.5 + 1.5 min (about 65% less) |
| Works served by 4 check slots | 1x | about 3x |
| upgrade, install-guide | once per Work | once per release |
| smoke, lint, secrets on the merge | run again | not run again |

- **Given up:** the heavy checks are checked once, at the end. A defect that
  only those checks catch can reach `dev`. Escaped defects 3, 7 and 8 and fl-6
  were release-boundary defects that `upgrade` caught per Work; they are now
  caught at release.
- **Why acceptable:** `system update` still refuses to switch `current` when
  the release check fails, so nothing reaches the running install. The
  operator accepts that another Work or the release check finds such a defect
  and a Work fixes it.
- **Gain:** the condition for raising Worker slots (5 to 7 on 2026-11-20).
- **Cost of finding it late:**
  - `dev` can hold a defect between releases;
  - the culprit is searched among the Items merged since the last release;
  - the release waits for the fix.

## Measure and revisit

ct-2 adds a count to `work report`: a late-caught defect is a release check
that fails on a check the Works skipped. When that count shows a check
catching defects at release repeatedly, move that check back to
`pull_request`. The operator reviews it at each milestone.

## External evidence (not System truth)

- Anthropic, "Redesigning source control at Anthropic" (2026-10-13,
  <https://www.anthropic.com/engineering/redesigning-source-control>), reports
  that a strict merge queue "doesn't make much sense at agent scale" and that
  they rely on post-merge and pre-deploy testing.
- Their test impact analysis
  (<https://claude.com/blog/agentic-coding-is-straining-ci-heres-how-we-scaled-test-impact-analysis-at-anthropic>,
  2026-09-14) selects tests deterministically from recorded history.
- System runs at about 50 Works a day, not 30,000 changes a day: the merge
  queue stays, lighter. Per-test selection is not adopted now; it is
  reconsidered from measured smoke/unit time after ct-2.
