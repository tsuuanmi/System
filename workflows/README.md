# Workflows

Workflow definitions are **data** (ADR-0002): `system.workflow/v1` YAML files
read at admission and pinned as a `workflow-spec@1` Artifact. Editing a file
changes future admissions only.

- [software-engineering.yaml](software-engineering.yaml) — `implement`
  (`code-write`) → `checks` (`code.required-checks`) → `publish`
  (`git.publish`: the checked commit to `system/<work>`, one draft pull
  request) → `accept`.
- [research.yaml](research.yaml) — `investigate` (`research`, `web-search`;
  outputs `report`, `sources`) → `citations` (`research.citation-check` on
  `sources`) → `accept`.
- [brainstorm.yaml](brainstorm.yaml) — `idea-a` (`brainstorm.idea-a`) and
  `idea-b` (`brainstorm.idea-b`) each write a `proposal` from the brief alone,
  with a stance each (pragmatist, skeptic);
  `synthesis` (`brainstorm.synthesis`) reads both exact proposals and writes a
  `summary`. No verifier: success means the three outputs exist. The bundle
  gives `idea-a` and `synthesis` to Claude Code and `idea-b` to Codex.

Comparison configurations for the Brainstorm evaluation are in
[experiments](experiments/README.md).

```sh
bin/system work submit --workflow workflows/research.yaml --input <artifactId>
```

The vocabulary and preflight rules are in
[workflow composition](../docs/architecture/workflow-composition.md).
