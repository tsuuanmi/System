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
- [brainstorm.test.ts](brainstorm.test.ts) — Brainstorm on the bundle's own
  accounts (CLI pointed at the fake): two proposals by different providers
  from the brief alone, a synthesis of both exact proposal Artifacts, refusal
  without Codex, a stop after the first proposal reusing it, and a pinned spec.
- [concurrency.test.ts](concurrency.test.ts) — parallel `system` commands
  writing one store all succeed (no "database is locked"), also when they
  all find the store missing and create it together.
- [publish.test.ts](publish.test.ts) — M5 gate: the whole Software
  Engineering file publishes one draft pull request to a bare remote and the
  fake GitHub in [fake-github.mjs](fake-github.mjs); a host killed after the
  pull request was created or during the push is reconciled without a
  duplicate; approval needs a human at a pseudo-terminal (`script`).
- [verify.test.ts](verify.test.ts) — M4 gate: both Workflow files through one
  controller with fake-CLI Workers and the real verifiers (git checks, citation
  fetches from a local site run in its own process).
