# @system/web-worker source

- [index.ts](index.ts) — the Cordis row: `register` an account of the `agents` row, and the sign-in operations (`ctx.webWorker`).
- [chatgpt.ts](chatgpt.ts) — the `web` Runtime's attempt: patchright on a genuine headed Chrome, the prompt, the generic Procedures of `@system/web-driver` for the page, labelled blocks, the `conversation@1`; the account as a `WorkerPort`.
- [migrate.ts](migrate.ts) — where an Account's state lives (`web/<site>/<name>`) and its one move from `chatgpt-web/<name>`.
- [health.ts](health.ts) — the per-Account circuit breaker: the durable state (`state.json`), the transitions from attempt outcomes, one notice per change, and the Worker that offers nothing while the Account is not ready.
- [recheck.ts](recheck.ts) — `system workers recheck`: the sign-in, mode and temporary-chat checks on a private Xvfb, sending nothing; the only way out of `needs-sign-in` and `challenged`.
- [evidence.ts](evidence.ts) — the attempt's evidence record: a stage chain written as it happens.
- [chrome.ts](chrome.ts) — which Chrome (configured, `CHROME_PATH`, recent system, pinned managed) and its install on first use.
- [chatgpt-login.ts](chatgpt-login.ts) — its sign-in: cookie import, or by hand in a window; the signed-in check (the driver's `checkAuth`, kept for it and for the recheck).
- [remote-login.ts](remote-login.ts) — the remote sign-in: the private Xvfb through a VNC server and noVNC on 127.0.0.1 behind a token, for use over an SSH tunnel (a port of System 1's remote login).
- [display.ts](display.ts) — the private Xvfb every browser runs on, `findXvfb` and `findVnc`.

See the [package README](../README.md).
