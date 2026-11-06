# Tests

Offline tests of the booted `system` profile. Each creates a throwaway
`DSH_HOME`, runs `bin/system init`, starts `bin/system host` for it
([test-support](../test-support/README.md) `start()`; the Host reads its
profile and credentials when it starts, so a test restarts it after changing
them), and drives the real CLI, which is a thin client of that Host. They need
`corepack pnpm install` and `corepack pnpm build` first, and no model or
GitHub credentials. Run with `corepack pnpm smoke`.

- [smoke.test.ts](smoke.test.ts) — boot, composition, row toggles, Artifacts.
- [host-process.test.ts](host-process.test.ts) — H4a: `bin/system host` as a
  child process: `host.hello` and `host.ping` on `host.sock`, a second Host
  refused, the Work commands reaching the running Host, SIGTERM and SIGINT
  stop it with exit 0 and free the home, a killed Host's stale socket is
  replaced, and what `init` says about the service.
- [cli-host.test.ts](cli-host.test.ts) — H4b-1: the thin client: no Host is one
  line and exit 1, a Host that does not answer is named, an error is one line
  (a stack only with `SYSTEM_DEBUG=1`), Ctrl-C detaches while the Work finishes
  in the Host, `--cancel-on-interrupt`, a timeout retried once with the same
  `commandId` (one Work), and `doctor` reporting the Host.
- [work.test.ts](work.test.ts) — M2 gate: both Workflow files and a direct
  Task through one controller with the `fakes` row on, invalid Workflows,
  the pinned spec across a file edit and a SIGKILLed host, SQLite durability.
- [agents.test.ts](agents.test.ts) — M3 on the real profile with the `agents`
  row pointed at a fake CLI: worktree capture, cross-process cancel, Codex
  takeover, `retry` refusals.
- [real-agents.test.ts](real-agents.test.ts) — credential-gated
  (`SYSTEM_REAL_AGENTS=1`): the operator's real Claude Code and Codex accounts,
  through the operator's Host when one answers, or one the test starts.
- [brainstorm.test.ts](brainstorm.test.ts) — Brainstorm on the bundle's own
  accounts (CLI pointed at the fake): two proposals by different providers
  from the brief alone, a synthesis of both exact proposal Artifacts, refusal
  without Codex, a stop after the first proposal reusing it, a host killed
  mid-step then four `work run`s at once against the restarted Host (one wins;
  the lost step is dispatched once more; no event lost), and a pinned spec.
- [conversation.test.ts](conversation.test.ts) — PROP-0003: a conversation
  previewed (nothing stored, secrets named not printed), `--yes` refused on a
  warning unless `--accept-warnings`, `--product-context`, stored, shown, and
  given to a Worker as a task's context under the operator-supplied notice.
- [concurrency.test.ts](concurrency.test.ts) — parallel `system` commands
  (Artifact writes through the Host, `doctor` boots beside it) on one store all
  succeed (no "database is locked"), also when the boots all find the store
  missing and create it together.
- [publish.test.ts](publish.test.ts) — M5 gate: the whole Software
  Engineering file publishes one draft pull request to a bare remote and the
  fake GitHub in [fake-github.mjs](fake-github.mjs); a Host killed after the
  pull request was created or during the push is reconciled at its next start
  without a duplicate; approval needs a human at a pseudo-terminal (`script`).
- [verify.test.ts](verify.test.ts) — M4 gate: both Workflow files through one
  controller with fake-CLI Workers and the real verifiers (git checks, citation
  fetches from a local site run in its own process).

## Regressions

The five defects of 2026-11-06 stay where their tests were written:

- SQLite store creation (processes all finding the store missing): `parallel
  commands that all find the store missing create it together without failing`
  in [concurrency.test.ts](concurrency.test.ts).
- The empty lock (a host that died while publishing): `an empty lock left long
  ago (a host that died while publishing) is stale and taken over` in
  [control.test.ts](../packages/work/tests/control.test.ts).
- Stale-lock removal (taking over a lock a live holder had replaced): `a stale
  lock replaced by a live holder before the takeover reads it again survives`
  and `two hosts racing for a stale lock never both win`, in
  [control.test.ts](../packages/work/tests/control.test.ts).
- The stale snapshot (a host acting on an older copy of a Work): `a host whose
  snapshot is older than the Work refuses to run it: no second dispatch, no
  event overwritten`, and its `retry`, `cancel` and `decide` siblings, in
  [controller.test.ts](../packages/work/tests/controller.test.ts).
- The profile config (a boot rewriting a file another host reads): `a boot
  does not rewrite the profile root config another booting host may be reading`
  in [concurrency.test.ts](concurrency.test.ts).
