---
id: PROP-0004
type: proposal
status: draft
created: 2026-11-06
summary: The design of milestone H (one long-lived Host, ADR-0007), as components each justified by a milestone goal, with decisions H1-H12 from the grilling and an explicit cut list; under a necessity review before implementation.
evidence: [RES-0008]
related: [ADR-0007, ADR-0008, ADR-0004, ADR-0001]
---

# Proposal: the Host (milestone H)

**Status:** draft. The operator agreed decisions H1-H12. Each component
below still has to pass a necessity review: is it really needed for a goal
of this milestone? Components that fail are cut or deferred before any code
is written.

## Goals of the milestone

Every component must serve at least one of these:

- **G1, one owner.** End the class of defects that comes from several
  processes owning one Work. Five such defects were found and fixed on
  2026-11-06 ([ADR-0007](../decisions/ADR-0007-one-long-lived-host.md)).
- **G2, parallel steps.** Run ready, independent steps (Brainstorm's two
  proposals) and separate Works at the same time, limited per Account,
  towards the operator's target of 20 Workers.
- **G3, an agent interface.** A stable interface for agents (MCP), which
  milestone O's Orchestrator needs, that can never approve.

Non-goals: remote access, multiple users, sandboxing, a durable scheduler
queue, live plugin reload, auto-resume after a crash, an Orchestrator or
Goal (milestone O).

## Architecture

```text
 operator shell                        agent (Claude Code, ...)
   system <cmd>  (thin CLI)              system mcp  (stdio MCP adapter)
        \                                    /
         \  JSON-RPC 2.0, one message per line (NDJSON)
          \                                /
       Unix socket  $DSH_HOME/system/host.sock   (systemd socket activation)
                          |
   ┌──────────────── Host: one DSH host, one process per DSH_HOME ───────────────┐
   │ operation registry   one table of operations; CLI and MCP surfaces derived │
   │ command receipts     commandId -> result, stored with the Work write       │
   │ commit lane          the only path that changes a Work (event append)      │
   │ scheduler            ready steps -> attempts, per-Account slots            │
   │ attempt runners      Runtimes, verifiers, effects run OUTSIDE the lane;    │
   │                      their results come back as events through the lane    │
   │ recovery             on start: interrupted attempts, held slots, reconcile │
   │ DSH composition      storage, artifacts, agents, verifiers, effects (as now)│
   └─────────────────────────────────────────────────────────────────────────────┘
   lock: abstract Unix socket "\0system-host:<hash of DSH_HOME>" held while alive
```

Human approval never crosses MCP. `system approve` runs in a terminal. It
shows the exact subject, and the Host checks that subject again before
recording the decision.

## Components and why each exists

| # | Component | Serves | Without it | Initial call |
|---|---|---|---|---|
| C1 | Host process owning every Work (single writer) | G1 | The cross-process races stay | must |
| C2 | Commit lane: every Work change appended through one ordered path; decisions read the latest committed state, never a snapshot taken before an `await` | G1, G2 | Concurrent attempts interleave inside one Work's decision | must |
| C3 | Scheduler with per-Account slots (default 1) | G2 | No parallel steps; or Accounts overcommitted | must |
| C4 | Operation registry: one table, from which the CLI and the MCP allowlist are derived | G3 | Two hand-kept surfaces drift; the MCP exclusions are untestable | must |
| C5 | Transport: JSON-RPC 2.0 framed as NDJSON on a Unix socket (H1). DSH's webserver is TCP-only; its own JSON-RPC server uses stdio framing | G1, G3 | No way to reach the Host | must |
| C6 | Thin CLI client; sends Workflow file contents, not paths (H9) | G1 | The CLI keeps owning Work | must |
| C7 | `system mcp` stdio adapter over the registry allowlist (H2) | G3 | No agent interface | must for G3 |
| C8 | `commandId` receipts on submit, run, retry, cancel, approve (H4) | G1, G3 | A lost reply plus a retry admits a second Work | review: needed now, or with MCP only? |
| C9 | Host lock as an abstract Unix socket per `DSH_HOME` (H5) | G1 | Two Hosts on one home | must |
| C10 | `system.service` with socket activation for the default home; `system host` in the foreground for others (H8, H9) | G1 | The operator starts and stops the Host by hand | review: is socket activation needed, or is a plain unit enough? |
| C11 | Recovery: interrupted attempts marked, uncertain attempts hold their slot until reconciled, no auto-resume (H6) | G1, G2 | Overcommit, or blind re-dispatch after a crash | must |
| C12 | Drain on stop: refuse new runs, finish in-flight attempts up to a budget, record the rest as interrupted | G1 | A stop loses attempts silently | review: is "record as interrupted" enough? |
| C13 | Waiting without streaming: `work.wait` and `work.events` with a cursor; Ctrl-C detaches (H7) | G1, G3 | Clients cannot follow a Work | must, minimal |
| C14 | `system doctor --offline`: read-only store access while the Host lock is free (H10) | operations | A wedged Host leaves no way to look | review |
| C15 | Cutover: the first start ignores and deletes the old lock, mutex and fence files; old-code removal in a separate PR (H11) | G1 | Old files confuse the new Host | must, small |
| C16 | A deterministic concurrency fixture (barriers, seeded delays) from the first step (H12) | G1, G2 (Charter 12) | Parallelism is tested last, or not at all | must |

## Decisions already taken (operator, 2026-11-06)

- **H1** JSON-RPC 2.0 over NDJSON on a Unix socket.
- **H2** One socket, with an MCP allowlist derived from the registry. Resisting a same-uid adversary is out of scope.
- **H3** One commit lane.
- **H4** `commandId` receipts.
- **H5** An abstract-socket lock.
- **H6** Slots held while an attempt is uncertain; no auto-resume.
- **H7** Ctrl-C detaches.
- **H8** systemd only for the default home.
- **H9** The unit's PATH is captured at init; the CLI sends file contents.
- **H10** `doctor --offline`.
- **H11** Cutover rules.
- **H12** Test order:
  1. extract the seam, with the fixture;
  2. API on a temporary socket;
  3. CLI cutover and systemd;
  4. MCP;
  5. parallelism.

## Cut list (deferred)

- Subscriptions and streaming.
- TCP or remote access.
- Auto-resume.
- A persisted scheduler queue, priorities and fairness tuning.
- Live profile and plugin reload.
- Sandboxing.
- Idle shutdown.
- Compaction.
- Orchestrator and Goal scopes.

## Open questions for the necessity review

- Which of C8, C10, C12 and C14 can wait for a later milestone without
  risking G1-G3?
- Is every "must" truly needed for its goal, or is there a smaller way to
  reach the goal?
- What does the Host make worse (a single point of failure, start-up
  dependence, operations) and what is the smallest mitigation?
