# Tests

The booted-profile smoke tests, run by `corepack pnpm smoke`. Each test file
creates a throwaway `DSH_HOME`, runs `bin/system init`, starts `bin/system host`
for it ([test-support](../test-support/README.md) `start()`; the Host reads its
profile and credentials when it starts, so a test restarts it after changing
them), and drives the real CLI, which is a thin client of that Host. They need
no model or GitHub credentials. The unit tests of each package are in
`packages/*/tests` and run by `corepack pnpm test`; a test belongs here when it
needs the booted profile and `bin/system`.

Run them after `corepack pnpm install` and `corepack pnpm build`. The files run
in parallel (`--test-concurrency=16`), which is safe because each file owns its
home (so its Host lock and socket), its repositories and its ports, and shares
nothing else.

## Which file runs where

Every `tests/*.test.ts` is run by `smoke`, except the ones the `smoke` script in
[package.json](../package.json) filters out; a new file is smoke unless that
filter names it. The check that runs each of the others is named in
[`.system/checks.yaml`](../.system/checks.yaml):

- `chatgpt-web.test.ts` needs a headed Chrome: `corepack pnpm test:web`, the `web` check.
- `upgrade-rehearsal.test.ts` builds two releases: the `upgrade` check.
- `install-guide.test.ts`: the `install-guide` check.

## Layer tests without bubblewrap

A test of the bubblewrap layer must pass or skip where bubblewrap cannot start (the GitHub runner has user namespaces off), never fail.
[sandbox-without-bwrap.test.ts](../packages/runtime-cli/tests/sandbox-without-bwrap.test.ts) enforces it: it runs each file it lists in a child
process with no working `bwrap`; a new layer test file is added to its list.
`SYSTEM_REQUIRE_SANDBOX=1` (set by the build check) turns a layer test's skip into a failure ([layer-gate.ts](../test-support/layer-gate.ts)); the Guardrail removes it from its children.

## Environment switches

- `SYSTEM_REAL_AGENTS=1` enables `real-agents.test.ts`: the operator's real Claude Code and Codex accounts.
- `SYSTEM_REAL_WEB=1` enables `real-web.test.ts`: the operator's signed-in `web/chatgpt/default` profile.
- `SYSTEM_SKIP_HEADED=1` skips the headed-Chrome tests, for a host with no Xvfb.

Without its switch a credential-gated file skips itself, so `smoke` stays offline.

## Rules

A flaky test is never skipped, slept or retried until it passes: find the root cause, or delete it with the reason and an Escaped defect and keep a deterministic test of what it guarded ([AGENTS.md](../AGENTS.md)).

A test file's header says which Item or gate it guards; that, not this README, is the inventory. [fake-github.mjs](../test-support/fake-github.mjs) is the fake GitHub that the publish tests start, and [fixtures](fixtures) holds the data tests read, such as the [review eval set](fixtures/review-evalset/README.md).

## Regressions

The five defects of 2026-11-06 stay where their tests were written:

- SQLite store creation (processes all finding the store missing): `parallel
  commands that all find the store missing create it together without failing`
  in [concurrency.test.ts](concurrency.test.ts).
- The empty lock, stale-lock removal and the stale snapshot went with the
  per-Work files (R1). One Host per home replaces them: the tests are named in
  the [Host's guarantees table](../docs/architecture/host.md#guarantees-and-the-tests-that-hold-them)
  (`one Host per home`, `no change from a stale copy`), and
  [host-process.test.ts](host-process.test.ts) shows the Host ignoring the old
  control files.
- The profile config (a boot rewriting a file another host reads): `a boot
  does not rewrite the profile root config another booting host may be reading`
  in [concurrency.test.ts](concurrency.test.ts).
