---
type: architecture
status: active
reviewed: 2026-11-27
decided-by: [ADR-0002]
covers: [packages/work/src/record.ts]
---

# The Work record: events and derived facts

How a Work's events are recorded and folded; the vocabulary that produces them
is in [workflow composition](workflow-composition.md), the code in the
[work package](../../packages/work/README.md).

**Implemented recovery:** each Work is one storage key holding its events
(`admitted`, `dispatched`, `observed`, `verified`, `waiting`, `attempt-lost`, `terminal`)
and the state they fold to; every change is one atomic update. A step whose
last attempt was dispatched but never observed is recorded `attempt-lost` and
dispatched again as a new attempt with the same recorded inputs (a Worker
attempt by the Host on start, once its process is confirmed gone; otherwise on
`system work run`, see [Start, stop and recovery](host.md#start-stop-and-recovery));
completed steps are never re-run. A step that waits for an Account's quota to reset is recorded `waiting`
(once per wait, with the reset time when known) until its next dispatch; it is not a failure.
`system work replay` folds the events again and
compares the result with the stored state.

**Derived facts (state).** `fold` computes, once, what readers used to re-scan
the events for: the verifiers pinned at admission (`state.verifiers`), a step's
latest reopening (`reopening`), the Outside failures in a row on a step
(`outside`), the changed tests of each change (`changedTests`) and the merge
commit an Approval covers (`effects[].approvedMerge`). A record stored without
them folds to the same facts when it is opened; no event gained a required field.

**Why a failure is Outside (cause-1).** The port that writes a failure's reason
also says its cause, as an optional `cause` (`attach`, `conflict` or `load`) on
the `observed`, `verified` and `effect-observed` events; the controller's own
failures carry `noChange` on `observed` and `hold` (`approval`, `inconclusive`)
on `terminal`. `outside.ts` is the only reader: it takes `cause` first and
matches the reason's words only for events without one, so old records
classify as before and a rewording elsewhere changes no hold.

**Attempt tool scope (scope-1).** An `observed` event's `worker` record may
carry an optional `scope` describing the tool bounds the attempt ran with
(permission mode, allowed and disallowed tools, sandbox mode, and the sha256
of any staged settings bytes; never tokens or environment values). Records
stored without `scope` parse and fold unchanged.

**Structured final result (finish-1).** An `observed` event may carry an
optional `finalResult` (`{ status: 'done' | 'blocked', reason }`) reported by
Codex and Antigravity attempts. When `status` is `blocked`, the attempt fails
with the Worker's own `reason` rather than "no change" or a missing output.
Records stored without `finalResult` parse and fold unchanged.

**Usage outcome (usage-1).** An `observed` event's `usage` record may carry an
optional `outcome` (`known`, `partial` or `unavailable`), a `reason` and an
`origin` (`stream`, `transcript` or `none`) saying where the counts were read.
`known` has tokens and cost; `partial` has tokens without a cost or a cache
split; `unavailable` has nothing. `work report` counts the outcomes per Runtime
(`costCoverage`) instead of reading unknown cost as zero, and `work report --since`
adds `usage` (`usageTotals`): token totals, cache-read share, cost and outcomes in
total and by Runtime, Account and local day of admission. Records stored
without them parse, and `usageOutcome` derives the outcome from what they hold.

**Attempt log and prompt (alog-1).** An `observed` event stores the whole
redacted Attempt log as `log` (truncated only at the spawner's 64 MiB capture
limit, with a marker in its last line) and may carry an optional `prompt`
Artifact ID holding the redacted prompt given to the Worker. Earlier records
stored without `prompt` parse and fold unchanged.
