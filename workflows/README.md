# Workflows

Workflow definitions are **data** (ADR-0002): `system.workflow/v1` YAML files
read at admission and pinned as a `workflow-spec@1` Artifact. Editing a file
changes future admissions only.

- [software-engineering.yaml](software-engineering.yaml) — `implement`
  (`code-write`) → `checks` (uses `code-checks.yaml`: step `checks.checks`) → `publish`
  (`git.publish`: the checked commit to `system/<work>`, one draft pull
  request) → `accept`.
- [software-engineering-docs.yaml](software-engineering-docs.yaml) — the same,
  plus `docs-impact` (`code-write`, `tier.economy`), which reads the change
  while the checks run and lists the docs it makes stale: advice, never a
  verdict. It becomes the default only if it often finds stale docs.
- [hygiene.yaml](hygiene.yaml) — `scout-docs`, `scout-code` and `scout-tree`
  (`code-write`, `tier.economy`, in parallel, read-only) → `plan` (picks what
  is worth doing) → `implement` → `checks` → `publish` → `accept`: one pull
  request of cleanup for any repository that has `.system/checks.yaml`.
- [code-checks.yaml](code-checks.yaml) — `checks` (`code.required-checks`
  on the input change, criteria pinned from its base). A Sub-workflow of
  `software-engineering.yaml`; on its own, on a task with a base, it checks that commit as it is.
  `system work retry <work> --step checks.checks` verifies the same change again.
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
