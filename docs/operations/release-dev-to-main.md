---
type: operations
status: active
reviewed: 2026-11-07
related: [ADR-0007, ADR-0008, ADR-0009, PROP-0003, PROP-0004, PROP-0005]
---

# Release report: `dev` into `main`, 2026-11-07

For the operator. `main..dev` is 73 commits, 25 merges and 162 files
(+11,448 −1,923). Every merge was a System Work except the plan and decision
commits. This report points to the documents; it does not restate them.

## 1. What changes for you

- **One long-lived Host.** `system.service` (a user unit) runs the one Host per
  machine; it owns the store, so the five lock and snapshot defects of the old
  per-command mode are gone with that mode. Install with `system init` and
  `systemctl --user enable --now system`. Design: [Host](../architecture/host.md);
  commands: [Runbook](runbook.md#cutover-to-the-host-r1).
- **Thin CLI.** `bin/system` no longer boots DSH. It talks to the Host's Unix
  socket, picks a Node DSH accepts, prints one-line errors, and detaches on
  Ctrl-C (`--cancel-on-interrupt` to cancel). With no Host it says so and exits 1
  ([Runbook](runbook.md#host-not-running)).
- **Parallel steps.** Independent steps (Brainstorm's two proposals) run at
  once, limited per Account by `maxConcurrentAttempts`; an attempt over
  `attemptTimeoutMinutes` (default 60) is stopped
  ([Runbook](runbook.md#attempts-at-once-and-held-slots)).
- **Goals and `system mcp`.** A Goal holds your aim, scope and budget; an
  Orchestrator agent connects through `system mcp`, is scoped to one Goal, may
  submit, run, cancel and retry, and never approve or merge. The Host notifies it
  of Work changes ([Runbook](runbook.md#goals-and-their-budget),
  [using System from an agent](runbook.md#using-system-from-an-agent)).
- **ChatGPT Website Worker.** The `chatgpt-web` Runtime drives your own signed-in
  ChatGPT session through Chrome. It is off by default: add the `agents` row and
  sign in with `system workers login chatgpt-web/default --cookies <file>`
  ([Runbook](runbook.md#the-chatgpt-web-account)).
- **Conversation ingestion.** A conversation (a ChatGPT exchange, or an import)
  is stored as an immutable `conversation@1` Artifact, previewed first and
  refused on warnings ([PROP-0003](../proposals/PROP-0003-conversation-ingestion.md)).
- **System merges into `dev`.** `git.publish` opens its PR against `dev` and may
  merge it once the required checks (`.system/checks.yaml`) pass on that exact
  commit. Only you merge `dev` into `main` ([ADR-0008](../decisions/ADR-0008-dev-integration-branch.md)).

## 2. Decisions taken

- [ADR-0007](../decisions/ADR-0007-one-long-lived-host.md): one long-lived Host per machine (amended: MCP moves to milestone O, a plain unit).
- [ADR-0008](../decisions/ADR-0008-dev-integration-branch.md): `dev` is where System integrates; the operator merges `dev` into `main`.
- [ADR-0009](../decisions/ADR-0009-goals-and-orchestrators.md): Goals and Orchestrators.
- [PROP-0004](../proposals/PROP-0004-host-design.md): the Host design, accepted with decisions N1–N12.
- [PROP-0005](../proposals/PROP-0005-chatgpt-website-worker.md): the ChatGPT Website Worker, accepted with the Terms-of-Use risk.
- [PROP-0003](../proposals/PROP-0003-conversation-ingestion.md): conversation ingestion; implemented, but its status is still `draft`.

## 3. Evidence

Gates are checked item by item in [PLAN.md](../../PLAN.md) (milestones H and O).

| Gate | Tests |
|---|---|
| R1: everything runs through the Host; a killed Host recovers; an agent cannot approve | `tests/cli-host.test.ts`, `tests/host-process.test.ts`, `packages/work/tests/host.test.ts`, `packages/host/tests/operations.test.ts`, `tests/publish.test.ts` |
| R2: parallel steps overlap; Account slots hold; replay is exact (seeds 1–50) | `packages/work/tests/slots.test.ts`, `tests/brainstorm.test.ts` |
| Milestone O: Goal budget, `system mcp`, Orchestrator scope, notices | `packages/work/tests/goal.test.ts`, `tests/goal.test.ts`, `packages/app/tests/mcp.test.ts`, `packages/host/tests/operations.test.ts` |

**Checks on `dev` (042b6a0), 2026-11-07, `corepack pnpm check`:** build and
typecheck pass; unit tests 405 of 405 pass (37 s); smoke tests 73, 70 pass, 0
fail, 3 skipped (the credential-gated `real-agents` and `real-web`; 6 min 16 s);
docs checks pass. The real-site and real-agent runs were not part of this run.

**Defects found and fixed in this range:**
- the five of the old mode: an empty lock, a stale-lock removal that moved a live
  lock, a stale store snapshot overwriting events, SQLite creation races, a
  profile config rewritten under a reader ([ADR-0007](../decisions/ADR-0007-one-long-lived-host.md));
- a Host restart read an absent effect as lost and stored an event that failed its schema;
- an attempt that hung ran 2 hours with no limit (now `attemptTimeoutMinutes`);
- a stopping Host waited for open client connections (HF1, PR #25);
- `git.publish` could match a pull request aimed elsewhere; the version handshake
  compared package versions, not built code (spec review of H);
- the Goal spec review (F2): Goal tokens ignored cache writes, admitted Works did
  not count as attempts, and more (PR #27);
- a conversation preview skipped fields, and its warnings did not block storing.

## 4. What System did itself

Costs are **API-equivalent estimates, not billing**; the subscription is not
billed per token ([ADR-0005](../decisions/ADR-0005-subscription-tokens-for-workers.md)).
A blank means the usage was not recorded (merged by hand, or before recording).

| PR | What it did | Min | Est. USD |
|---|---|---|---|
| #5 | Brainstorm default: a stance per proposal | | |
| #6 | Resolve the Dependabot alerts | | |
| #7 | `git.publish` merges into an allowlisted base | | |
| #8 | H1: controller seam, deterministic concurrency fixture | 16 | |
| #9 | H2: Host lock, commit lane, recovery | 29 | |
| #10 | H3 groundwork: agent runtimes and summary | 15 | |
| #11 | H3: Host transport (Unix socket) | 20 | |
| #12 | H3: agent worker changes for the Host | 17 | |
| #13 | H3: operation table and API | 26 | |
| #14 | Citation verifier v2 | 15 | 0.24 |
| #15 | Research run fixes under verifier v2 | 22 | 0.30 |
| #16 | H4a: `system host`, unit, Node selection | 14 | 0.19 |
| #17 | Attempt time limit | 127 | 0.36 |
| #18 | H4b-1: the thin CLI | 54 | 3.71 |
| #19 | H4b-2: the old mode removed; gate R1 | 21 | 1.94 |
| #20 | H5: parallel steps, Account slots; gate R2 | 62 | 14.27 |
| #21 | O1: Goal and its budget | 20 | 1.72 |
| #22 | H spec review: three defects, cleanup | 26 | 0.50 |
| #23 | W1: `chatgpt-web` Runtime | | |
| #24 | H two-axis review, simplification pass | 21 | 1.66 |
| #25 | HF1: Host stop no longer waits for clients | 19 | 0.70 |
| (no PR) | O2: `system mcp`, Orchestrator scope (Work 14441ec5) | | |
| #26 | O3: completion notices | 25 | 2.88 |
| #27 | O spec review fixes (F2) | 38 | 4.58 |
| #28 | O simplification pass | 20 | 2.11 |
| **Total** | 25 merges | **607** (20 with data) | **35.17** (14 with data) |

Tokens over the 14 recorded Works: fresh input 2,694; cache read 149,684,550;
cache write 2,934,540; output 869,119. The data does not cover the Works marked
blank, so the totals are a floor. PR numbers #10–#13, #15 and #22 are matched to
steps by the files they changed.

## 5. Open items and risks

- **Core growth debt, your decision.** The active core
  (`packages/work/src`, `packages/artifacts/src`) is 3,008 lines, +29.8% against
  a +20% budget, about 230 lines over. No removal was found; the growth is
  behaviour (receipts, slots, scheduler, conversation and Goal folds). Paying it
  down means dropping a feature. Keep the debt, or name the feature to drop
  ([PLAN.md](../../PLAN.md#growth-and-feedback-budgets-charter-11-and-12)).
- **Docs budget.** `docs/` was 4,283 lines against a 4,285 limit before this
  report, which exceeds it. The report is dated; delete it after the cutover.
- **ChatGPT Terms of Use.** An automated session is against OpenAI's Terms; you
  accepted that risk for your own account. System stops at a sign-in wall or
  CAPTCHA and never works round them.
- **Yours to do.** The cutover checklist ([Runbook](runbook.md#cutover-to-the-host-r1))
  and the ChatGPT sign-in; the machine has no display, so use `--cookies`.
- **Not exercised for real.** The `chatgpt-web` Runtime against chatgpt.com
  (`SYSTEM_REAL_WEB=1`); the cutover on your home with a live service; an
  Orchestrator driven by a real agent over `system mcp`. Also not built: remote
  sign-in over SSH (W2), two ChatGPT accounts for Brainstorm (W3), a scheduled
  Orchestrator.

## 6. Merge checklist

1. Review this report.
2. Merge PR #4 first, if it is still open (this Worker could not check it).
3. Merge `dev` into `main`.
4. Run the [Runbook](runbook.md#cutover-to-the-host-r1) cutover, then sign in to ChatGPT if you want that Worker.
