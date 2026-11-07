# test-support

Helpers shared by the tests, so each stand-in has one implementation:

- [memory.ts](memory.ts) — the Artifact record table, blob store, Artifact
  store and Work table in memory (durable before visible, an `update` atomic,
  like DSH), and
  `until` for bounded waits.
- [process.ts](process.ts) — `processSpawner` (the DSH subprocess contract:
  process group, SIGTERM, SIGKILL after the grace).
- [fixture.ts](fixture.ts) — the deterministic concurrency fixture: a
  `WorkController` with fake Workers whose attempts are held at named barriers
  (`hold`, `arrived(step, count)`, `release`) or delayed by a seeded generator
  (`fixture({ seed })`, so a seed reproduces an interleaving). Its Workers are
  two Accounts, `fake/claude` and `fake/codex` (Brainstorm's `idea-b` is the
  Codex one), with `fixture({ slots })` as their `maxConcurrentAttempts`, `peak`
  (the most attempts of an Account at once) and `gone(attemptId)` (confirm a lost
  attempt's process gone). It also has
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

- [headed.ts](headed.ts) — `skipHeaded`: the reason a test that needs a headed
  Chrome on a private Xvfb cannot run here (no Chrome, no Xvfb, or Chrome does not
  start: [headed-probe.ts](headed-probe.ts) tries one), or false.

It is not a package: tests import it by path. It imports the built
`@system/*` packages, so run `corepack pnpm build` first (`corepack pnpm check`
does).
