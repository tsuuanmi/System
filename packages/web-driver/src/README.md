# @system/web-driver source

- [driver.ts](driver.ts) — `ChatGptWebDriver`: what is left of System 1's driver for the login and the recheck (`checkAuth`, `open`, `diagnostics`, the map); every element, action and state comes from [the map](../ui/chatgpt-web.ui.yaml).
- [procedures.ts](procedures.ts) — the generic Procedures (WW2-ii): fixed control flow over the engine, bound to a Site by its map; no Site name in it.
- [ui-ops/](ui-ops) — System 1's UI engine: map loading, resolution, actions and their postconditions, answers, drift evidence, self-heal.
- [core/](core) — the parts of System 1's provider-core and libs the two above import.
- [index.ts](index.ts) — what `@system/web-worker` imports.

See the [package README](../README.md) for the source of each file and every difference from System 1.
