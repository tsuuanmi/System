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
No implementation exists in this repository yet.

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

- Crash before assigning the Worker; crash during execution; crash after a
  remote effect but before confirmation; crash after result before verification.
- Cancel an attempt and disable its backing DSH plugin mid-flight.
- Layer a higher-priority configuration patch that overrides the intended
  enablement, and confirm that admission observes **effective** state.
- Try a malicious or buggy Worker adapter that reports false success or
  attempts unauthorized data egress.
- Retry a resumed session whose usage report is cumulative, not incremental.
- Change the artifact after checks to prove stale verification is rejected.

## Answered for MVP-0

[ADR-0004](../decisions/ADR-0004-mvp-0-operating-decisions.md) answers two
earlier questions: System owns the work semantics and stores them in the DSH
storage hub (one key per Work, one atomic update per transition), and Workers
use a System-owned adapter built on DSH's subprocess and credential layers
because the stock subagent adapters drop usage and workspace changes.

## Unanswered design questions

- Can a plugin update be staged and drained without bypassing Cordis lifecycle?
- Which provider metering oracle and result verification can be reproduced in
  a local CI fixture?
- What minimum Worker contract represents both code patches and research
  reports without encoding either domain?

The [MVP contract](../requirements/mvp.md) owns required behavior; this page
records possible mechanisms until experiments choose one.
