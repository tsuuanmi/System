# UI engine

System 1's `packages/ui-ops/src`, [engine.ts](engine.ts) first: it resolves a
[map](map.ts) element to one visible match, runs an action and checks its
postcondition, evaluates states with the passive [network](network.ts)
observer, and heals a drifted element within bounds ([heal.ts](heal.ts); off
in System). [answers.ts](answers.ts) reads an answer's text, Markdown and links,
[outline.ts](outline.ts) describes a page as structure only (drift evidence),
[locate.ts](locate.ts) turns a candidate into a Locator and [site.ts](site.ts)
holds what the site drivers share. System 1's `packages/ui-ops/README.md` (at the commit in the
[package README](../../README.md)) describes each in full.
