# @system/agents source

- [workspace.ts](workspace.ts) — attempt directory, inputs, prompt, output capture, cleanup.
- [runtimes.ts](runtimes.ts) — Claude Code and Codex argv, environment and output parsing.
- [chatgpt.ts](chatgpt.ts) — the `chatgpt-web` Runtime's attempt: Playwright on Chrome, page reading, labelled blocks.
- [chatgpt-login.ts](chatgpt-login.ts) — its sign-in: cookie import, or by hand in a window.
- [agent.ts](agent.ts) — one account as a `WorkerPort`, behind a `Spawner` seam.
- [index.ts](index.ts) — the Cordis row: accounts, DSH subprocess and credentials.

See the [package README](../README.md).
