---
id: PROP-0004
type: proposal
status: accepted
created: 2026-11-06
summary: The design of milestone H (one long-lived Host, ADR-0007), as components each justified by a milestone goal; after a necessity review the operator accepted a serial Host first (R1) and parallelism second (R2), MCP moved to milestone O, and each deferral has a trigger.
evidence: [RES-0008]
related: [ADR-0007, ADR-0008, ADR-0004, ADR-0001]
---

# Proposal: the Host (milestone H)

**Status:** accepted on 2026-11-06, after a necessity review. A Brainstorm
(Work `work:5e9141d7…`) reviewed every component against the goals, and the
operator decided points N1-N12. The architecture this milestone builds is
described in [Host architecture](../architecture/host.md).

## Goals of the milestone

Every component must serve at least one of these:

- **G1, one owner.** End the class of defects that comes from several
  processes owning one Work. Five such defects were found and fixed on
  2026-11-06 ([ADR-0007](../decisions/ADR-0007-one-long-lived-host.md)).
- **G2, parallel steps.** Run ready, independent steps (Brainstorm's two
  proposals) and separate Works at the same time, limited per Account,
  towards the operator's target of 20 Workers.
- **G3, an agent interface.** A stable interface for agents (MCP), which
  milestone O's Orchestrator needs, that can never approve. **Moved to
  milestone O (N1).** H keeps only what makes G3 a small step later.

Non-goals: remote access, multiple users, sandboxing, a durable scheduler
queue, live plugin reload, auto-resume after a crash, an Orchestrator or
Goal (milestone O).

## Decisions (operator, 2026-11-06)

- **First grilling.**
  - **H1** JSON-RPC 2.0 framed as NDJSON on a Unix socket.
  - **H2** One socket, with an agent allowlist; resisting a same-uid adversary is out of scope.
  - **H3** One commit lane.
  - **H4** `commandId` receipts.
  - **H5** An abstract-socket lock.
  - **H6** An uncertain attempt keeps its slot; no auto-resume.
  - **H7** Ctrl-C detaches.
  - **H8** systemd only for the default home.
  - **H9** The unit's PATH is captured at init, and the CLI sends file contents.
  - **H10** `doctor --offline`, later deferred by N10.
  - **H11** Cutover.
  - **H12** Fixture first.
- **Necessity review.**
  - **N1** MCP moves to milestone O.
  - **N2** A plain unit: no socket activation, with lingering and a ping timeout.
  - **N3** The old mode is removed in the cutover change.
  - **N4** Releases R1 (serial) and R2 (parallel).
  - **N5** Keep receipts.
  - **N6** Keep one lane.
  - **N7** Cursor polling.
  - **N8** Version handshake and caller.
  - **N9** Reads go through the Host.
  - **N10** Defer `doctor --offline`.
  - **N11** A memory report.
  - **N12** The documents listed below.

## Components: final verdicts

| # | Component | Serves | Verdict | Trigger for a deferral |
|---|---|---|---|---|
| C1 | Host process owning every Work (the single writer) | G1 | keep; stop sets a flag to refuse new runs, then exits (C12 folded in) | — |
| C2 | One commit lane: every Work change goes through one ordered path; decisions read the latest committed state | G1, G2 | keep (H3, N6). The only writer of the Work table is `WorkController`, and DSH's domain write chain is already serial | per-Work lanes if a 20-Work run shows the lane is busy |
| C3 | Scheduler: readiness, plus a slot per Account (default 1) | G2 | shrink: no priorities, no fairness tuning, no persisted queue; ships in R2 | — |
| C4 | Operation table: one dispatch table with an `agent` flag | G1 (and G3 later) | shrink: no generated schemas; a test that agents cannot reach approve, deny, `credentials set` or conversation storage | — |
| C5 | Transport: JSON-RPC 2.0, NDJSON framing, Unix socket | G1 | keep, minimal (H1); bounded frame size | — |
| C6 | Thin CLI; sends Workflow file contents | G1 | keep; read commands also go through the Host (N9) | — |
| C7 | `system mcp` adapter | G3 | **deferred to milestone O** (N1) | an agent must drive System before O |
| C8 | `commandId` receipts on submit, run, retry, cancel and approve | G1 | keep (N5). A receipt is stored in the same Work write; a submitted Work's ID derives from its `commandId` | — |
| C9 | Host lock: an abstract Unix socket per canonical `DSH_HOME` | G1 | keep (H5) | — |
| C10 | `system.service` | G1 | shrink: a plain unit with `Restart=on-failure`, the captured PATH and lingering; no socket activation (N2); the CLI pings with a timeout | starting the Host by hand becomes a recurring cost |
| C11 | Recovery: interrupted attempts marked, uncertain attempts keep their slot until reconciled, no auto-resume | G1, G2 | keep (H6) | — |
| C12 | Drain | G1 | folded into C1: refuse new runs, then exit; anything cut short is C11's job on the next start | — |
| C13 | Following a Work: `work.events` with a cursor; the CLI polls every second; Ctrl-C detaches | G1 | keep, minimal (N7, H7) | a long poll if a 20-Work run shows polling costs |
| C14 | `system doctor --offline` | operations | **deferred** (N10) | the first wedged or unstartable Host that existing tools cannot diagnose |
| C15 | Cutover | G1 | shrink: the Host ignores the old lock, mutex and fence files; the old mode is removed in the cutover change, with a cutover and rollback checklist (N3) | — |
| C16 | Deterministic concurrency fixture (barriers, seeded delays) from the first step | G1, G2 | keep (H12), starting with regressions for the five defects of 2026-11-06 | — |
| C17 | Version handshake, and a caller recorded on every call | G1 | added (N8): a long-lived Host can outlive the code a new CLI expects | — |
| C18 | Memory report: Work count and record size in `host.status` | Charter 11 | added (N11): recorded in PLAN's growth budget | compaction when the report exceeds its budget |

## Build order and releases (N4)

1. The controller seam and the deterministic fixture, with regressions for
   the five defects. Writers inventory (done: `WorkController` is the only
   Work writer).
2. Host lock, commit path, recovery, `commandId` receipts.
3. The API on a temporary socket, with the version handshake and caller.
4. Cutover: thin CLI, `system.service`, old mode removed, cutover and
   rollback checklist. **Release R1** (G1, serial).
5. Parallel steps and Works with per-Account slots, with barrier tests for
   shared-Account contention and for restarts. **Release R2** (G2).

## Documents and cut list

The milestone leaves this proposal, the amended
[ADR-0007](../decisions/ADR-0007-one-long-lived-host.md), the
[Host architecture](../architecture/host.md) (diagram, guarantees and their
tests, and the deferred items), the API reference in the Host package README,
the [runbook](../operations/runbook.md) and the PLAN gate with its growth
measures. Idle shutdown and Orchestrator and Goal scopes were cut with the
other deferrals.

## Answered by the review

C8 stays because it costs almost nothing, C10 shrinks, C12 folds into C1 and
C14 is deferred. What the Host makes worse, and the mitigation: it is a single
point of failure (supervised unit, `Restart=on-failure`, conservative
recovery); the CLI depends on it starting (a clear "not running" or "not
answering", never a silent fallback); it may run old code after an upgrade
(the version handshake).
