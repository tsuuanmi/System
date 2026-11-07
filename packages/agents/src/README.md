# @system/agents source

- [workspace.ts](workspace.ts) — attempt directory, inputs, prompt, output capture, cleanup.
- [runtimes.ts](runtimes.ts) — Claude Code and Codex argv, environment and output parsing.
- [web.ts](web.ts) — the seam to the optional web Runtime: the `webWorker` service contract and the "row is disabled" reason (types and one message).
- [agent.ts](agent.ts) — one account as a `WorkerPort`, behind a `Spawner` seam.
- [index.ts](index.ts) — the Cordis row: accounts, DSH subprocess and credentials; hands `chatgpt-web` accounts to the web-worker row.

See the [package README](../README.md).
