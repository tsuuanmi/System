# @system/agents adapters

One adapter per CLI Runtime. Everything that differs between Runtimes lives here; `agent.ts`, `ask.ts` and `index.ts` ask the registry and never branch on a Runtime's name (`tests/adapters.test.ts` fails if one does).

- [types.ts](types.ts) — `CliAdapter`: invocation, credential staging (`preflight`), output parse, progress, attempt summary, quota reader, account identity, registration.
- [index.ts](index.ts) — the registry keyed by Runtime name (`adapterFor`) and `summarizeAttempt`.
- [claude-code.ts](claude-code.ts) — Claude Code, with the flags pinned by rb-4 (`--allowedTools`, `--disallowedTools`).
- [sandbox.ts](sandbox.ts) — the `sandbox` Account option (a spike, off by default, Claude Code only): the settings JSON passed with `--settings`.
- [codex.ts](codex.ts) — Codex, with `-s workspace-write`.

**`sandbox` option (spike).** An Account of the Claude Code Runtime whose profile sets `sandbox: true` (or `{ allowRead: [absolute paths], allowedDomains: [hosts] }`) runs its attempts with Claude Code's own sandbox (bubblewrap): what Bash starts cannot read the operator's real home (from the passwd entry) except the attempt's directories, the repository's git directory and the Node toolchain on PATH, and cannot write outside the working tree, `in/`, `out/` and the throwaway HOME; it never fails open (`failIfUnavailable`, no unsandboxed commands). Claude Code documents no way to leave the network open with the file-system sandbox on, so Bash reaches only `allowedDomains` (none by default). The Read and Edit tools, WebFetch, WebSearch, hooks and MCP servers are outside the sandbox. Codex and web Accounts refuse the option. Off by default: without it the argv is unchanged. What a real attempt can do under it is shown only by the gated test in `tests/real-agents.test.ts`.

The `web` Runtime has no adapter: the web-worker row serves it (see [web.ts](../web.ts)). Adding a CLI Runtime is writing one adapter and registering it. See the [package README](../../README.md).
