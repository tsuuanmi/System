# Tests

Offline tests of the booted `system` profile. Each creates a throwaway
`DSH_HOME`, runs `bin/system init`, starts `bin/system host` for it
([test-support](../test-support/README.md) `start()`; the Host reads its
profile and credentials when it starts, so a test restarts it after changing
them), and drives the real CLI, which is a thin client of that Host. They need
`corepack pnpm install` and `corepack pnpm build` first, and no model or
GitHub credentials. Run with `corepack pnpm smoke`: the test files run in
parallel (`--test-concurrency=16`), which is safe because each file owns its
home (so its Host lock and socket), its repositories and its ports, and shares
nothing else.

- [smoke.test.ts](smoke.test.ts) — boot, composition, row toggles, Artifacts.
- [bootstrap-check.test.ts](bootstrap-check.test.ts) — bs-2: `system bootstrap check`
  through `bin/system` against a temporary git repository (no Host).
- [night-session.test.ts](night-session.test.ts) — ss-8: the scheduled session's
  sequence (claim, task_new, work_submit, `work wait`, work_report)
  through `system mcp` against a real Host with fake Workers.
- [mcp-update.test.ts](mcp-update.test.ts) — one running `system mcp` calls
  tools across two atomic install-link switches and real Host upgrades.
- [host-process.test.ts](host-process.test.ts) — H4a: `bin/system host` as a
  child process: `host.hello` and `host.status` on `host.sock`, a second Host
  refused, the Work commands reaching the running Host, SIGTERM and SIGINT
  stop it with exit 0 and free the home, a killed Host's stale socket is
  replaced, leftover control files of the old mode ignored and left in place, and
  what `init` says about the service.
  `system host --supervise` serves and stops with exit 0 and no new Host.
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
  takeover, `retry` refusals, and the `quota:` line `system workers` prints per account
  (a readable one from a fake Codex CLI, unreadable where the CLI version is unverified).
- [real-agents.test.ts](real-agents.test.ts) — credential-gated
  (`SYSTEM_REAL_AGENTS=1`): the operator's real Claude Code and Codex accounts,
  through the operator's Host when one answers, or one the test starts.
- [web-worker-off.test.ts](web-worker-off.test.ts) — WW2a: the profile with the
  `web-worker` row off (the bundle's default) runs a Software Engineering Work and a
  Brainstorm on the fake Runtimes, `system workers` reports a `web` account
  unavailable with "the web-worker row is disabled", and `workers login` says the same.
- [chatgpt-web.test.ts](chatgpt-web.test.ts) — the `web` account (the
  `web-worker` row turned on by a profile patch) on
  the booted profile against the local fake site ([web-driver](../packages/web-driver/tests/fake-chatgpt.ts)): `workers login --cookies`
  (no value printed), a sign-in wall reported, a Work filling its slot and
  producing a conversation. A headed Chrome that cannot start fails it (`SYSTEM_SKIP_HEADED=1` skips).
- [real-web.test.ts](real-web.test.ts) — credential-gated (`SYSTEM_REAL_WEB=1`):
  one Research Work on the operator's signed-in `web/chatgpt/default` profile.
- [web-canary.test.ts](web-canary.test.ts) — WW4 (run by `corepack pnpm test:web`, not smoke): the canary Task has the same
  Artifact ID every time, `work submit --worker` refuses an unregistered Worker, and
  `tools/web-canary` runs and reports (each run classified as passed, worker-failed, verifier or other, the Worker step rate, older version apart, the WW gate)
  through a fake `system` (`SYSTEM_BIN`) with scripted records; the timer units' fields.
- [brainstorm.test.ts](brainstorm.test.ts) — Brainstorm on the bundle's own
  accounts (CLI pointed at the fake): two proposals by different providers
  from the brief alone, a synthesis of both exact proposal Artifacts, refusal
  without Codex, a stop after the first proposal reusing it, a host killed
  mid-step, then the restarted Host dispatches the lost step again by itself,
  once, with no `work run` (no event lost), a pinned spec, and
  (H5) the two proposals overlapping in time, compared by `dispatched` and
  `observed` timestamps.
- [debate.test.ts](debate.test.ts) — WW2b: the Debate Workflow on the fake CLI: dispatch
  order a1/b1, a2/b2, synthesis; each Round 2 step's inputs are exactly the
  Round 1 proposals and the brief; the synthesis gets all four; replay.
- [concurrency.test.ts](concurrency.test.ts) — parallel `system` commands
  (Artifact writes through the Host, `doctor` boots beside it) on one store all
  succeed (no "database is locked"), also when the boots all find the store
  missing and create it together.
- [publish.test.ts](publish.test.ts), [publish-crash.test.ts](publish-crash.test.ts), [publish-approval.test.ts](publish-approval.test.ts) — M5 gate, three files so they run in parallel, sharing [publish.ts](../test-support/publish.ts): the whole Software
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
- The empty lock, stale-lock removal and the stale snapshot went with the
  per-Work files (R1). One Host per home replaces them: the tests are named in
  the [Host's guarantees table](../docs/architecture/host.md#guarantees-and-the-tests-that-hold-them)
  (`one Host per home`, `no change from a stale copy`), and
  [host-process.test.ts](host-process.test.ts) shows the Host ignoring the old
  control files.
- The profile config (a boot rewriting a file another host reads): `a boot
  does not rewrite the profile root config another booting host may be reading`
  in [concurrency.test.ts](concurrency.test.ts).
