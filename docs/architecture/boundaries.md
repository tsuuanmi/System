---
type: architecture
status: draft
reviewed: 2026-11-05
---

# Draft boundaries and failure scenarios

This is a **working technical sketch** inside the
[selected control-plane architecture](control-plane.md). The product role and
DSH host are already decided in
[ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md);
specific schemas, service keys, process boundaries and storage remain open.

## Minimum candidate contracts

| Contract | Input | Output | Must be testable |
|---|---|---|---|
| Work admission | requested outcome, constraints, input artifacts | stable work ID, accepted/held reason | no phantom or duplicate work IDs |
| Worker capability | declared skills, boundaries, availability | admitted adapter/session/attempt | worker replacement and unsupported capability |
| Execution result | authorized input references, work/attempt ID | artifact reference, completion evidence, usage provenance | cannot self-accept or widen its permissions |
| External effect | unique operation ID, scope, authorization | committed/failed/unknown state | crashes cannot cause blind duplicate effect |
| Verification | frozen result reference and criteria | verdict + evidence bound to same reference | changed artifact invalidates earlier verdict |
| Lifecycle control | plugin identity, desired state, in-flight assignments | admitted/draining/disabled/unavailable | safe disable/re-enable and dependency loss |

These are conceptual contracts. Precise wire formats are deferred until the
smallest two-workflow spike validates the transitions.

## Candidate invariants to prove

1. Work identity and material artifacts outlive any Worker session or process.
2. Unknown external effects reconcile or hold; they are not blindly retried.
3. A Worker cannot authorize its own privilege, network egress or credentials.
4. A decision is attributable to an operator or applicable policy version.
5. Verification binds to the exact artifact and records checked evidence.
6. Usage claims include origin, scope, completeness and deduplication rule.
7. An optional plugin being disabled cannot invalidate core state or bypass
   the admission gate.
8. An unavailable required plugin blocks dependent work explicitly, even if
   unrelated plugins remain healthy.
9. Software Engineering and Research share one controller state machine.

## Failure points for a controlled spike

The crash, cancel, plugin-disable, denial and replacement scenarios are the
[MVP failure tests](../requirements/mvp.md#failure-and-governance-tests). The
ones it does not name:

- a higher-priority configuration patch that overrides the intended
  enablement: admission must observe **effective** state;
- a malicious or buggy Worker adapter that reports false success;
- a resumed session whose usage report is cumulative, not incremental;
- crash after a result but before verification, and an artifact changed after
  its checks (stale verification is rejected).

## Answered for MVP-0

[ADR-0004](../decisions/ADR-0004-mvp-0-operating-decisions.md) decisions 5 and
9 answer two earlier questions: Work semantics live in the DSH storage hub (one
key per Work, one atomic update per transition), and Workers use a
System-owned adapter because the stock subagent adapters drop usage and
workspace changes. The minimal Worker contract for both code patches and
research reports is `WorkerRequest`/`WorkerResult` in `@system/work`.

## Unanswered design questions

- Can a plugin update be staged and drained without bypassing Cordis lifecycle?
- Which provider metering oracle and result verification can be reproduced in
  a local CI fixture?

The [MVP contract](../requirements/mvp.md) owns required behavior; this page
records possible mechanisms until experiments choose one.
