# @system/web-driver source

- [driver.ts](driver.ts) — `ChatGptWebDriver`: System 1's driver, procedures over the UI engine; every element, action and state comes from [the map](../ui/chatgpt-web.ui.yaml).
- [ui-ops/](ui-ops) — System 1's UI engine: map loading, resolution, actions and their postconditions, answers, drift evidence, self-heal.
- [core/](core) — the parts of System 1's provider-core and libs the two above import.
- [index.ts](index.ts) — what `@system/agents` imports.

See the [package README](../README.md) for the source of each file and every difference from System 1.
