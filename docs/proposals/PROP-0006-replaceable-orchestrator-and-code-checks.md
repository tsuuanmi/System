---
id: PROP-0006
type: proposal
status: accepted
created: 2026-11-07
summary: An Orchestrator session is replaceable like a Worker because its state lives in System (decisions as Artifacts, a brief generated from records, live attempt progress with stall notices), and the required checks become a Sub-workflow that Workflows use and that can be retried on its own.
related: [ADR-0002, ADR-0003, ADR-0007, ADR-0009]
---

# Proposal: a replaceable Orchestrator, and the checks as a Sub-workflow

**Status:** accepted by the operator (2026-11-07), to be built from `dev` as
one pull request, outside the Website Worker programme (`web-workers`).

## Context

- The Orchestrator ([ADR-0009](../decisions/ADR-0009-goals-and-orchestrators.md))
  has an agent's authority, but its memory lives in the agent session: which
  Works run, which direction was chosen from a synthesis, what comes next,
  what went wrong. A new session has to re-read PLAN and guess.
  System 1 kept that state in the system (its ADR-0076: the lead is a
  principal; its INV-13: every decision is an Artifact), so a lead session
  could be replaced. The operator wants the same: replacing the Orchestrator
  session must work like replacing a Worker.
- A Software Engineering Work on 2026-11-07 finished its implement step after
  25 minutes and stayed "running" for 33 more: two Xvfb processes leaked by
  the Worker's own tests held its output pipe open. Nobody noticed, because
  the only way to see progress was to read files by hand.
- When the required checks failed for a reason outside the change (the Host
  ran with Node 22 on its `PATH`; a stale lockfile rule), the only way to
  check again was to run a new implement attempt or to merge by hand.
  `system work retry` re-runs Worker steps only.

## Decision

1. **Decisions are Artifacts.** A `decision@1` records a question, the
   options, the choice, the reason and the Artifact IDs it rests on
   (a synthesis, a review, a check-run). `system decision add` (Host
   operation `decision.add`, `agent: true`, scoped to the caller's Goal
   like `work.submit`) and `decision list [--goal <id>]`. A decision is a
   record, never an authority: approve, deny and merging into `main` stay
   the operator's.
2. **A brief generated from records.** `system goal brief <id>` (and the
   MCP tool `goal.brief`) prints, deterministically and with no model call:
   the Goal and its budget left; its Works with status, current step and
   progress; the recent decisions; and what is waiting (approvals, held,
   failed, stalled Works). A new Orchestrator session starts from it.
3. **Live progress, kept out of the record.** The Host keeps for each running
   attempt: elapsed time, last activity time, and what the Runtime reports
   (for Claude Code from its stream-json: turns, the last tool, tokens so
   far; for the web Runtime its evidence stages). `work show`, `work.show`
   and the brief include it. It is an observation of the moment, not an
   event, so the Work record stays small and replay stays exact.
4. **Stall notice.** An attempt with no activity for `stallMinutes` (default
   10) is reported as stalled: `work.changed` fires and MCP clients get
   `notifications/resources/updated`, so a script that polls every 30 s,
   or an Orchestrator, is woken without spending tokens while it waits.
5. **The checks as a Sub-workflow.** Implements Sub-workflows as decided in
   the [ADR-0002 amendment](../decisions/ADR-0002-work-primitive-configured-workflows.md):
   a step `uses: <workflow>` is expanded into the pinned spec at admission,
   namespaced, no recursion, depth ≤3; the controller is unchanged.
   `workflows/code-checks.yaml` holds the `code.required-checks` verify step;
   `software-engineering.yaml` uses it. For now it is one verify step that
   runs the checks in parallel on one build (a separate step per check waits
   until per-check retry is needed and builds are shared).
6. **Verify again.** `system work retry --step <verify-step>` re-runs a verify
   step on the same subject, with the same pinned criteria, and resets the
   steps after it; the previous verdict stays in the record and never
   counts. This is how a check that failed for an environmental reason is
   run again without a new implement attempt or a merge by hand.

## Acceptance

Each with a test that failed first, through the Host:

- A decision added by an orchestrator caller names its Goal; one for another
  Goal is refused; `decision list --goal` returns them in order.
- `goal brief` on a Goal with a running, a failed and a held Work, and two
  decisions, prints all of them; the same records give the same text.
- A fake agent that reports turns and then goes quiet: `work show` shows its
  progress, and after `stallMinutes` (shortened in the test) a stall notice
  reaches a `work.watch` client; the Work record has no progress events.
- A Workflow that `uses:` another is expanded with namespaced step IDs and
  replays exactly; recursion and depth 4 are refused at admission.
- `software-engineering.yaml` through `code-checks.yaml`: a failed check, then
  `work retry --step checks.checks` after fixing the environment, passes on
  the same subject, and the Work is accepted; the failed verdict is kept.
- The required checks stay within their budget (Charter 12).

## Out of scope

The merge queue, the Worker tool policy (no background tasks for Software
Engineering Workers, a per-attempt budget), one-line failure reasons and
check selection by `paths` are separate steps; an Orchestrator that System
starts on its own stays deferred (ADR-0009).
