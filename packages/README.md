# Packages

System's source packages, one pnpm workspace member each. Packages are split
only when lifecycle or configuration demands it (PLAN.md package guidance).

- [bundle](bundle/README.md) — `@system/bundle`, the only bundle of the
  `system` DSH profile: the explicit Cordis tree.
- [artifacts](artifacts/README.md) — `@system/artifacts`, the `artifacts` row:
  immutable content-addressed Artifacts.
- [app](app/README.md) — `@system/app`, the CLI app row (`system doctor`,
  `system work`).
