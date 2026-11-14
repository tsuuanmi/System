# Workflows

Workflow definitions are **data** (ADR-0002): `system.workflow/v1` YAML files
read at admission and pinned as a `workflow-spec@1` Artifact. Editing a file
changes future admissions only.

The canonical Workflows are `develop.yaml`, `hygiene.yaml`, `research.yaml` and
`brainstorm.yaml`, and the Sub-workflow `code-checks.yaml`. The code Workflows
use the role `code.develop` on their Worker steps (in `hygiene.yaml`, the plan
and implement steps). `code-write` is the permission to write the checkout, not
a role; it is also what makes the working tree a step's output. See
[GLOSSARY.md](../GLOSSARY.md) for the term.

- [develop.yaml](develop.yaml) — the default for any change to a repository:
  `implement` (`code-write`, `code.develop`, `tier.standard`; works test-first:
  the tests for the new behaviour fail for the right reason, then the code, the
  existing tests that pin changed behaviour updated, the repository's checks run
  before it finishes) → `checks` (uses `code-checks.yaml`: step `checks.checks`)
  → `publish` (`git.publish`: the checked commit to `system/<work>`, one draft
  pull request) → `accept`. `implement`'s `retry` names `checks.checks` and
  `publish` (sc-7: a conflict or a failing check on the merge reopens it on the
  base's new tip). Satisfied (ro-15; version 4): `implement` may also write the optional
  output `satisfied`, naming existing tests (`<test file> "<test name>"` per line)
  that show the Item already holds at the base; then `satisfied-check` runs exactly
  those tests on the Task's base, `checks`, `publish` and `accept` are skipped, and a
  pass ends the Work succeeded with the result "satisfied", publishing nothing.
- [hygiene.yaml](hygiene.yaml) — `scout-docs`, `scout-code` and `scout-tree`
  (`code-write`, `tier.economy`, in parallel, read-only) → `plan` (picks what
  is worth doing) → `implement` (`retry` on `checks.checks` and `publish`, sc-7; version 3) → `checks` → `publish` → `accept`: one pull
  request of cleanup for any repository that has `.system/checks.yaml`. It fits a change that keeps behaviour.
- [code-checks.yaml](code-checks.yaml) — `checks` (`code.required-checks`
  on the input change, criteria pinned from its base). A Sub-workflow of
  `develop.yaml` and `hygiene.yaml`; on its own, on a task with a base, it checks that commit as it is.
  `system work retry <work> --step checks.checks` verifies the same change again.
  A check that fails on the change and on its base, and again on both after one re-run (sc-13), is `inconclusive` (df-25): the Work is held for approval, not retried (before `publish`) ([runbook](../docs/operations/runbook.md#a-check-the-base-fails-too)).
- [research.yaml](research.yaml) — `investigate` (`research`, `web-search`, `tier.standard`, `prefer: research.web`, one `retry`;
  outputs `report`, `sources`) → `citations` (`research.citation-check` on
  `sources`, with the `report` as an input; criteria `citations-v2`) → `accept`. `investigate` goes to an Account that has the role
  `research.web` (a `web` Account, given the role in the profile) and to any other capable Account
  when none can take it (unavailable, signed out, limited, no free slot, or its attempt failed and it
  left routing); `prefer` ranks without requiring, so a Host with no such Account still runs it; version 5.
- [brainstorm.yaml](brainstorm.yaml) — `idea-a` (`brainstorm.idea-a`) and
  `idea-b` (`brainstorm.idea-b`) each write a `proposal` from the brief alone,
  with a stance each (pragmatist, skeptic);
  `synthesis` (`brainstorm.synthesis`) reads both exact proposals and writes a
  `summary`. No verifier: success means the three outputs exist. The bundle
  gives `idea-a` and `synthesis` to Claude Code and `idea-b` to Codex.

Comparison configurations for the Brainstorm evaluation, and the Workflows that
are not canonical (`second-opinion.yaml`, `debate.yaml`, `research-fanout.yaml`),
are in [experiments](experiments/README.md).

```sh
bin/system work submit --workflow workflows/research.yaml --input <artifactId>
```

[`tools/web-canary`](../tools/web-canary) runs it on a fixed question for the
`web` Accounts ([runbook](../docs/operations/runbook.md#the-web-canary)).

The vocabulary and preflight rules are in
[workflow composition](../docs/architecture/workflow-composition.md).
