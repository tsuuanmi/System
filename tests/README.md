# Tests

Offline tests of the booted `system` profile. Each creates a throwaway
`DSH_HOME`, runs `bin/system init`, and drives the real CLI. They need
`corepack pnpm install` and `corepack pnpm build` first, and no model or
GitHub credentials. Run with `corepack pnpm smoke`.

- [smoke.test.ts](smoke.test.ts) — boot, composition, row toggles, Artifacts.
- [work.test.ts](work.test.ts) — M2 gate: both Workflow files and a direct
  Task through one controller with the `fakes` row on, invalid Workflows,
  the pinned spec across a file edit and a SIGKILLed host, SQLite durability.
