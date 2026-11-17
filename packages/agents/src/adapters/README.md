# @system/agents adapters

One adapter per CLI Runtime. Everything that differs between Runtimes lives here; `agent.ts`, `ask.ts` and `index.ts` ask the registry and never branch on a Runtime's name (`tests/adapters.test.ts` fails if one does).

- [types.ts](types.ts) — `CliAdapter`: invocation, credential staging (`preflight`), output parse, progress, attempt summary, quota reader, account identity, registration.
- [index.ts](index.ts) — the registry keyed by Runtime name (`adapterFor`) and `summarizeAttempt`.
- [claude-code.ts](claude-code.ts) — Claude Code, with the flags pinned by rb-4 (`--allowedTools`, `--disallowedTools`).
- [codex.ts](codex.ts) — Codex, with `-s workspace-write`.

The `web` Runtime has no adapter: the web-worker row serves it (see [web.ts](../web.ts)). Adding a CLI Runtime is writing one adapter and registering it. See the [package README](../../README.md).
