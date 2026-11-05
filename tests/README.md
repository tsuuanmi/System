# Tests

Offline tests of the booted `system` profile. Each creates a throwaway
`DSH_HOME`, runs `bin/system init`, and drives the real CLI. They need
`corepack pnpm install` and `corepack pnpm build` first, and no model or
GitHub credentials. Run with `corepack pnpm smoke`.

- [smoke.test.ts](smoke.test.ts) — boot, composition, row toggles, Artifacts.
- [work.test.ts](work.test.ts) — M2 gate: both Workflow files and a direct
  Task through one controller with the `fakes` row on, invalid Workflows,
  the pinned spec across a file edit and a SIGKILLed host, SQLite durability.
- [agents.test.ts](agents.test.ts) — M3 on the real profile with the `agents`
  row pointed at a fake CLI: worktree capture, cross-process cancel, Codex
  takeover, `retry` refusals.
- [real-agents.test.ts](real-agents.test.ts) — credential-gated
  (`SYSTEM_REAL_AGENTS=1`): the operator's real Claude Code and Codex accounts.
- [verify.test.ts](verify.test.ts) — M4 gate: both Workflow files through one
  controller with fake-CLI Workers and the real verifiers (git checks, citation
  fetches from a local site run in its own process).
