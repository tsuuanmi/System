# test-support

Helpers shared by the tests, so each stand-in has one implementation:

- [memory.ts](memory.ts) — the Artifact record table, blob store, Artifact
  store and Work table in memory (durable before visible, like DSH), and
  `until` for bounded waits.
- [process.ts](process.ts) — `processSpawner` (the DSH subprocess contract:
  process group, SIGTERM, SIGKILL after the grace).
- [fixture.ts](fixture.ts) — the deterministic concurrency fixture: a
  `WorkController` with fake Workers whose attempts are held at named barriers
  (`hold`, `arrived`, `release`) or delayed by a seeded generator
  (`fixture({ seed })`, so a seed reproduces an interleaving), and
  `startHost(home)` (a `Host` over the same table and Workers, for restarts),
  `remote` (what the fake publisher's reconcile reports), and
  `assertConsistent`: the stored state equals the fold of the events, and no
  event `seq` is missing or repeated.
- [cli.ts](cli.ts) — `systemCli`: a throwaway DSH home, a runner for
  `bin/system` (`run`, and `runAsync` for a command that outlives a call), and
  the Host the smoke tests talk to: `start()` runs `bin/system host` as a child
  process and waits for its socket (a second `start()` restarts it), `pid()`
  names it for a test that kills it, and `stop()` sends SIGTERM (SIGKILL after
  10 s). Call `stop()` from `after`. For the [smoke tests](../tests/README.md).

It is not a package: tests import it by path. It imports the built
`@system/*` packages, so run `corepack pnpm build` first (`corepack pnpm check`
does).
