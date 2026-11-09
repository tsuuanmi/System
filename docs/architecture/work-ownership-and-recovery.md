---
type: architecture
status: active
reviewed: 2026-11-07
---

# Runtime integrity: Work ownership, storage and recovery

**Status: the old mechanisms are gone (R1).** Until checkpoint R1 every `system`
command booted its own DSH host, and the hosts coordinated through files: a
per-Work lock with a takeover mutex, and a write fence against stale store
snapshots. Five defects came from that model on 2026-11-06 (an empty lock,
stale-lock removal moving a live lock, a stale snapshot overwriting events, a
SQLite store-creation race and a profile config rewritten under a reader).
One Host per home now owns every Work, so those files, their tests and their
residual race windows are removed. How the Host does it, and the test that
holds each guarantee, are in [the Host](host.md#guarantees-and-the-tests-that-hold-them);
how recovery works is in [Start, stop and recovery](host.md#start-stop-and-recovery).

The accepted Work and effect semantics remain in
[ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md),
[ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md)
and [ADR-0004](../decisions/ADR-0004-mvp-0-operating-decisions.md). The
earlier analysis (RES-0007) is retired; see the [ledger](../governance/retired.md).

**Atomicity is scoped.** A serialized update of *one stored Work key* protects
that key's transition; it does not atomically commit Artifact bytes, metadata
or a GitHub effect. The **operation intent and remote-state reconciliation**
contract covers effects.

## Crash/recovery invariant map

1. **Work admission:** no committed Work without valid pinned spec, inputs
   and capability preflight.
2. **Dispatch:** event and input IDs are persisted before Worker execution.
   A host crash leaves an interrupted attempt, not an imaginary success.
3. **Artifact result:** missing output metadata/bytes cannot be accepted;
   orphaned content may be inspected/collected after reconciliation.
4. **Restart:** completed steps and their Artifact IDs are reused. Unknown
   attempts must get new attempt IDs; reconstruct state from recorded events,
   not regenerated model output.
5. **GitHub effect:** write intent before remote call. On timeout/crash,
   inspect branch/PR using operation identity; no blind repeated publish.
6. **Verifier:** bind verdict to exact subject/criteria; a replayed verdict
   does not retroactively attest a changed Artifact.
7. **Cancellation:** preserve observed partial outputs as unaccepted
   Artifacts; a cancel from a client never grants another process the right to run a step.
8. **Operator:** a Work status, actual effect outcome and reason remain
   explainable after recovery.

Old `$DSH_HOME/system/control/*.lock`, `*.takeover` and `*.written` files are
ignored by the Host; the [runbook](../operations/runbook.md#moving-to-the-install-df0b)
has the operator delete them. The two SQLite and profile-config defects stay
covered by `concurrency.test.ts`, which now runs through the Host.

Current implementation is a **trusted, single-operator prototype**. This page
addresses correctness and durability, **not** the deferred container/egress
security program. See [Brainstorm contract](brainstorm-composition.md).
