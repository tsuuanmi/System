# @system/agents source

- [workspace.ts](workspace.ts) — attempt directory, inputs, prompt, output capture, cleanup.
- [runtimes.ts](runtimes.ts) — Claude Code and Codex argv, environment and output parsing.
- [web.ts](web.ts) — the seam to the optional web Runtime: the `webWorker` service contract and the "row is disabled" reason (types and one message).
- [ask.ts](ask.ts) — one model turn with no tools on an economy-tier Account (`ask`), for the Classifier.
- [agent.ts](agent.ts) — one account as a `WorkerPort`, behind a `Spawner` seam.
- [index.ts](index.ts) — the Cordis row: accounts, DSH subprocess and credentials; hands `web` accounts to the web-worker row.

See the [package README](../README.md).
