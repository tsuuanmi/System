# Tests

Offline tests of the booted `system` profile. Each creates a throwaway
`DSH_HOME`, runs `bin/system init`, and drives the real CLI. They need
`corepack pnpm install` and `corepack pnpm build` first, and no model or
GitHub credentials. Run with `corepack pnpm smoke`.
