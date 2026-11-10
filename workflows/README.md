# Workflows

Workflow definitions are **data** (ADR-0002): `system.workflow/v1` YAML files
read at admission and pinned as a `workflow-spec@1` Artifact. Editing a file
changes future admissions only.

The code Workflows use two roles: `code.develop` (the plan, implement and docs
steps; in `hygiene.yaml`, the plan and implement steps) and `code.tests` (the
tests step). `code-write` is the permission to write the checkout, not a role.
See [GLOSSARY.md](../GLOSSARY.md) for the term.

- [feature.yaml](feature.yaml) — the default for a code change: `plan` (`code-write`, `code.develop`, read-only: what to
  change, where, which tests prove it) → `tests` (`code.tests`,
  `tier.standard`: the plan's tests, failing, before any code; `retry` on `red`, `checks-code` and an `OBJECTION:` of `implement`) →
  `red` (`code.required-checks`, criteria `red-v1`: the `red: pass` checks pass
  and a `red: fail` one fails on the tests' change; an `inconclusive` verdict holds the Work before `implement`: approve continues, deny fails) → `implement`
  (`code-write`, `code.develop`: make them pass; `freeze`s the tests step's files: an edit to one is undone when its change is recorded (dg-10); one `retry` per `tests-frozen` and `checks-code`; a frozen test it says is wrong ends its message with `OBJECTION: <test>: <why>`) →
  `tests-frozen` (`code.required-checks`, criteria `tests-frozen-v1`: no file the
  tests step wrote changed; the backstop of `freeze`) → `checks-code` → `docs` (`code.develop`, `code.docs`,
  `tier.economy`) → `checks` → `publish` → `accept`. Each stage reads only the
  Artifacts it is given; the profile decides which Account takes each role.
  The default for a code change (df-27, concluded in df-20).
- [software-engineering.yaml](software-engineering.yaml) — `implement`
  (`code-write`, `code.develop`) → `checks` (uses `code-checks.yaml`: step `checks.checks`) → `publish`
  (`git.publish`: the checked commit to `system/<work>`, one draft pull
  request) → `accept`. Still fits a change too small for a plan, a change
  that keeps behaviour (a cleanup, a refactor, a docs-only change), and a
  repository with no `red:` in its `.system/checks.yaml` (feature.yaml's red
  check would refuse it).
- [software-engineering-docs.yaml](software-engineering-docs.yaml) — the same,
  plus `docs-impact` (`code-write`, `tier.economy`), which reads the change
  while the checks run and lists the docs it makes stale: advice, never a
  verdict. It becomes the default only if it often finds stale docs.
- [feature-research.yaml](feature-research.yaml) — the same, with `research`
  (`research`, `web-search`, `tier.standard`) first, whose report and sources
  the plan reads.
- [hygiene.yaml](hygiene.yaml) — `scout-docs`, `scout-code` and `scout-tree`
  (`code-write`, `tier.economy`, in parallel, read-only) → `plan` (picks what
  is worth doing) → `implement` → `checks` → `publish` → `accept`: one pull
  request of cleanup for any repository that has `.system/checks.yaml`. Like
  software-engineering.yaml it fits a change that keeps behaviour: feature.yaml's
  red check needs a new failing test, so such a change cannot pass it.
- [code-checks.yaml](code-checks.yaml) — `checks` (`code.required-checks`
  on the input change, criteria pinned from its base). A Sub-workflow of
  `software-engineering.yaml` and `feature.yaml`; on its own, on a task with a base, it checks that commit as it is.
  `system work retry <work> --step checks.checks` verifies the same change again.
  A check that fails on the change and on its base is `inconclusive` (df-25): the Work is held for approval, not retried (at `red` before `implement`, else before `publish`) ([runbook](../docs/operations/runbook.md#a-check-the-base-fails-too)).
- [research.yaml](research.yaml) — `investigate` (`research`, `web-search`, `tier.standard`;
  outputs `report`, `sources`) → `citations` (`research.citation-check` on
  `sources`, with the `report` as an input; criteria `citations-v2`) → `accept`.
- [brainstorm.yaml](brainstorm.yaml) — `idea-a` (`brainstorm.idea-a`) and
  `idea-b` (`brainstorm.idea-b`) each write a `proposal` from the brief alone,
  with a stance each (pragmatist, skeptic);
  `synthesis` (`brainstorm.synthesis`) reads both exact proposals and writes a
  `summary`. No verifier: success means the three outputs exist. The bundle
  gives `idea-a` and `synthesis` to Claude Code and `idea-b` to Codex.
- [debate.yaml](debate.yaml) — a Debate of two Rounds: `a1` and `b1` write a
  `proposal` each from the brief alone (the Brainstorm stances); in Round 2 `a2`
  and `b2` read both proposals and write a `rebuttal` with a revised proposal,
  on the same capabilities, so each side keeps its Account; `synthesis` reads
  all four Artifacts and writes a `summary`. No verifier.
- [research-fanout.yaml](research-fanout.yaml) — `plan` (`research.plan`) splits the
  question into `question-a` and `question-b`; two Lanes, `investigate-a`
  (`research.lane-a`) and `investigate-b` (`research.lane-b`), each run the
  `research.yaml` investigation (shared by a YAML anchor) and have their `sources`
  checked; `synthesis` (`research.synthesis`) merges both into one `report` and
  `sources`, checked again. A profile gives each Lane to a different Account. Each Lane
  asks `tier.standard`, like `research.yaml`.

Comparison configurations for the Brainstorm evaluation are in
[experiments](experiments/README.md).

```sh
bin/system work submit --workflow workflows/research.yaml --input <artifactId>
```

[`tools/web-canary`](../tools/web-canary) runs it on a fixed question for the
`web` Accounts ([runbook](../docs/operations/runbook.md#the-web-canary)).

The vocabulary and preflight rules are in
[workflow composition](../docs/architecture/workflow-composition.md).
