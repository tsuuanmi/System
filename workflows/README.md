# Workflows

Workflow definitions are **data** (ADR-0002): `system.workflow/v1` YAML files
read at admission and pinned as a `workflow-spec@1` Artifact. Editing a file
changes future admissions only.

- [software-engineering.yaml](software-engineering.yaml) — `implement`
  (`code-write`) → `checks` (`code.required-checks`) → `accept`.
- [research.yaml](research.yaml) — `investigate` (`research`, `web-search`;
  outputs `report`, `sources`) → `citations` (`research.citation-check` on
  `sources`) → `accept`.

```sh
bin/system work submit --workflow workflows/research.yaml --input <artifactId>
```

The vocabulary and preflight rules are in
[workflow composition](../docs/architecture/workflow-composition.md).
