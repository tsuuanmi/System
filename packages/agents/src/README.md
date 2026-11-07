# @system/agents source

- [workspace.ts](workspace.ts) — attempt directory, inputs, prompt, output capture, cleanup.
- [runtimes.ts](runtimes.ts) — Claude Code and Codex argv, environment and output parsing.
- [chatgpt.ts](chatgpt.ts) — the `chatgpt-web` Runtime's attempt: patchright on a genuine headed Chrome, the prompt, the `@system/web-driver` driver for the page, labelled blocks, the `conversation@1`.
- [chrome.ts](chrome.ts) — which Chrome (configured, `CHROME_PATH`, recent system, pinned managed) and its install on first use.
- [chatgpt-login.ts](chatgpt-login.ts) — its sign-in: cookie import, or by hand in a window; the signed-in check (the driver's `checkAuth`).
- [remote-login.ts](remote-login.ts) — the remote sign-in: the private Xvfb through a VNC server and noVNC on 127.0.0.1 behind a token, for use over an SSH tunnel (a port of System 1's remote login).
- [display.ts](display.ts) — the private Xvfb every browser runs on, `findXvfb` and `findVnc`.
- [agent.ts](agent.ts) — one account as a `WorkerPort`, behind a `Spawner` seam.
- [index.ts](index.ts) — the Cordis row: accounts, DSH subprocess and credentials.

See the [package README](../README.md).
