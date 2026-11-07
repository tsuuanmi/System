---
id: PROP-0007
type: proposal
status: accepted
created: 2026-11-07
summary: Software Engineering Workers run commands in the foreground under a per-attempt budget; the required checks pin their Node, give one-line failure reasons and run only what a change touches; System merges into an integration branch through a merge queue that checks the merge result.
related: [ADR-0003, ADR-0007, ADR-0008, PROP-0006]
---

# Proposal: Worker policy, faster and clearer checks, and a merge queue

**Status:** accepted by the operator (2026-11-07), to be built from `dev`
after [PROP-0006](PROP-0006-replaceable-orchestrator-and-code-checks.md)
(PR #39), apart from the Website Worker programme (`web-workers`).

## Evidence (System's records, 2026-11-07)

- Software Engineering Works: implement is 70–85% of a Work's time (median
  about 18 min). Usage is mostly 1–6M input tokens (mostly cache reads),
  but WW1 used 183M over 13 turns and WW1c 86M: the Worker waited on its test
  runs with background tasks and monitors that never ended, and each wake
  re-read the whole context.
- 6 of 17 Works failed their checks; 4 for reasons outside the change (the Host
  ran with Node 22 on its `PATH` twice; a Worker rule forbade the lockfile
  twice), 1 on a timing-dependent test, 1 early smoke failure. Each verdict
  said only "unit (exit 1)", so the cause had to be dug out by hand.
- A batch of four parallel Works each passed its own checks and their merges
  broke `dev` together.
- Unit took 202 s once a milestone's headed-browser tests joined it (38 s
  before); every check runs on every change.

## Decision

1. **Worker policy for Software Engineering.** The Claude Code and Codex
   Accounts that do `code-write` run with background tasks and monitors
   disallowed (for Claude Code, `--disallowedTools` of the background and
   monitor tools); the task rules say to run each command in the foreground
   under `timeout`.
2. **A per-attempt budget.** The `agents` row gains `attemptBudget` (input
   tokens, and minutes beside `attemptTimeoutMinutes`), checked against the
   usage the Runtime already observes as it streams; an attempt over it is
   stopped and fails with the reason "over budget: <what>". Its partial
   output is kept.
3. **Checks pin their Node.** The verifier runs every check with the Node the
   repository asks for (`engines.node` in `package.json`, found as `bin/system`
   finds it), whatever the Host's `PATH`.
4. **One-line failure reasons.** A failed check's verdict reason names the
   check, the first failing test and its first error line, read from the
   test runner's output (TAP or spec), for example
   `unit: chatgpt.test.ts "a cancel …": promptSubmitted false !== true`.
   A timed-out check names the test that was running.
5. **Checks selected by paths.** A check in `.system/checks.yaml` may have
   `paths` (globs, as GitHub Actions' `paths` filter). It runs only when the
   change, against its base commit, touches one of them; a check without
   `paths` always runs. The verdict lists each check as run or skipped, with
   its time. Budgets: the main path under 3 min on a quiet machine; a
   path-selected check states its own.
6. **A merge queue.** System merges into an integration branch (`mergeInto`)
   only when the required checks passed on the **merge result with the
   branch's current tip**, one merge at a time through the commit lane: if the
   branch moved after the checks, the change is merged onto the new tip and
   checked again (the "not rocket science" rule of bors, and GitHub's merge
   queue). A merge conflict fails the publish step with the conflicting
   files named; nothing is merged blindly.
7. **Sub-workflows resolved by the Host.** A caller of `work.submit` names
   the Workflow; the Host reads the Sub-workflows it `uses:` from the same
   base commit (or the bundled `workflows/`), so an MCP caller no longer sends
   their content (follow-up of PR #39).
8. **The flaky Host test.** `tests/host-process.test.ts` "SIGTERM stops the
   Host … and a new Host starts" timed out once at a load average of about
   200: make it wait for events, not times.

## Acceptance

Each with a test that failed first:

- A fake agent that starts a background job is refused it; one that exceeds
  the token budget is stopped with "over budget: input tokens".
- With the Host's `PATH` on Node 22, the checks still run on Node 24.
- A failing test's verdict reason names the check, the test and its first
  error line; a timed-out check names the running test.
- A change touching only `docs/` skips a check whose `paths` are
  `packages/**`, and the verdict says so; a change touching `packages/`
  runs it.
- Two changes checked against the same tip: the second is merged only after
  being checked against the tip that includes the first; a conflict fails
  with the files named.
- `work.submit` of `software-engineering.yaml` through MCP without the
  Sub-workflow's content succeeds.
- The required checks stay under 3 min on a quiet machine (Charter 12).
