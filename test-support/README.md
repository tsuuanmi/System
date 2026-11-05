# test-support

Helpers shared by the tests, so each stand-in has one implementation:

- [memory.ts](memory.ts) — the Artifact record table, blob store, Artifact
  store and Work table in memory (durable before visible, like DSH), and
  `until` for bounded waits.
- [process.ts](process.ts) — `processSpawner` (the DSH subprocess contract:
  process group, SIGTERM, SIGKILL after the grace) and `LocalControl` (one
  process, no other host).
- [cli.ts](cli.ts) — `systemCli`: a throwaway DSH home and a runner for
  `bin/system`, for the [smoke tests](../tests/README.md).

It is not a package: tests import it by path. It imports the built
`@system/*` packages, so run `corepack pnpm build` first (`corepack pnpm check`
does).
