# Packages

System's source packages, one pnpm workspace member each. Packages are split
only when lifecycle or configuration demands it (the [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md) package guidance).

- [bundle](bundle/README.md) — `@system/bundle`, the only bundle of the
  `system` DSH profile: the explicit Cordis tree.
- [artifacts](artifacts/README.md) — `@system/artifacts`, the `artifacts` row:
  immutable content-addressed Artifacts.
- [work](work/README.md) — `@system/work`, the `work` row: Work records, the
  Workflow compiler and the Work Controller.
- [fakes](fakes/README.md) — `@system/fakes`, a scripted Worker and verifier,
  off by default.
- [agents](agents/README.md) — `@system/agents`, the `agents` row: Claude Code
  and Codex accounts as Workers.
- [verifiers](verifiers/README.md) — `@system/verifiers`, the `verifiers` row:
  `code.required-checks` and `research.citation-check`.
- [effects](effects/README.md) — `@system/effects`, the `effects` row:
  `git.publish`, push and one draft pull request, never a merge.
- [app](app/README.md) — `@system/app`, the CLI app row (`system doctor`,
  `system artifact`, `system work`).
