---
type: architecture
status: draft
reviewed: 2026-11-06
---

# Runtime integrity: single-Work ownership, storage and recovery

**Status: technical design review / hypotheses; not a new accepted ADR.**
The accepted Work and effect semantics remain in
[ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md),
[ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md)
and [ADR-0004](../decisions/ADR-0004-mvp-0-operating-decisions.md).
Source and observed tests are pinned in
[RES-0007](../research/RES-0007-brainstorm-and-concurrency-review.md).

## Two different concurrency problems

| Problem | Current mechanism in draft PR #2 | What has/has not been proved |
|---|---|---|
| **SQLite store access / creation** | DSH SQLite pnpm patch: `busy_timeout`, WAL switch retry, and idempotent unit-version insertion | A concurrent-command bootstrap regression and stress report passed; this is **not** a test of two processes executing the **same Work**. |
| **Single-Work ownership / event consistency** | One Work record/key, atomic storage update, and a PID-named per-Work `FileControl` lock around Work execution | Work replay and cancellation tests passed. Same-Work dispatch exclusivity, stale lock takeover and concurrent retry/approval still need focused cross-process tests. |

**Atomicity is scoped.** A serialized update of *one stored Work key*
protects that key's transition under the storage API's conditions; it
does not atomically commit artifact bytes, metadata, a GitHub effect, or
a second host's in-memory cache. The **operation intent and remote-state
reconciliation** contract is still required.

## Candidate P1: lock publication race

In PR #2's
[`FileControl.acquire()`](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/packages/work/src/control.ts),
a process creates the lock path via `openSync(path, 'wx')` and writes
its PID via a **subsequent** `writeSync`. Meanwhile, the stale check
calls `holder()`, which treats an empty/unparseable PID as
`undefined`, then can call `takeStale()` and move/remove the path.
A second host could therefore see an **incomplete active lock** as
stale before the first host has published its PID. Under an unlucky
interleaving, two hosts could believe they own the same Work.

This is a **source-derived race hypothesis, not a reproduced failure**.
Write a deterministic interleaving test before selecting a fix.
A correct solution must **atomically publish an initialized ownership
record** (or use a tested OS-level lock) and must not steal/remove a
new owner's lock when cleaning stale state. Test owner identity/token
and inode/compare-and-delete behavior, PID reuse and process death;
a mere delay before stale cleanup is insufficient as a correctness proof.

A related hypothesis is the **retry gap**:
[`WorkController.retry()`](https://github.com/tsuuanmi/System/blob/4a71c79f5fc9ed4857bd027625eda8b56f854bb8/packages/work/src/controller.ts)
appends a `reopened` event under a lock, releases it and then
calls `run(workId)` to reacquire it. Concurrent `run`/`retry`/
`cancel` on that boundary should be tested for exactly one
active attempt and coherent terminal status. This also is **not yet
a confirmed defect**. Prefer a narrow fix within existing control
boundaries before proposing a persistent daemon or lease service.

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
   Artifacts; cancellation by another CLI must not accidentally grant a
   competing host the right to run a step.
8. **Operator:** a Work status, actual effect outcome and reason remain
   explainable after recovery.

## Recommended deterministic B4 test matrix

| Injected interleaving / fault | Required observable result |
|---|---|
| Hold process A between exclusive lock create and PID write; let B acquire | At most one owner; B refuses/queues instead of stealing A's live lock |
| Crash A before lock publication; start B | B recovers stale/incomplete ownership without perpetual blockage |
| Two CLI processes call `work run` on same Work | At most one active Worker attempt and no duplicate dispatch event |
| A retries while B runs or cancels the same Work | No lost reopened/terminal event; final replay matches persisted state |
| Simultaneous distinct Works and initial store bootstrap | No SQLite lock/unique error or unrelated Work starvation |
| Kill writer during event/Artifact persistence | Work state and references remain reconcilable; no false success |
| Kill after GitHub publish before receipt | Reconcile existing effect; do not open duplicate draft PR |
| PID reuse / lock path replaced during stale cleanup | Never remove a newer owner's lock |
| Persistent WAL contention under load | No unbounded retry; measure latency, error classification and queue behavior |

Use a barrier/fault-hook in **fake-process tests** so the lock-publication
interleaving is reproducible; many random stress iterations alone are not
a proof that the gap is closed. Keep the existing SQLite patch regression;
upstream upgrades must rerun these probes before removing the pnpm patch.

## Deferred alternatives, only after a failing fixture

- Use a validated atomic ownership protocol or OS file lock first.
- Consider a **generation/fencing token** if a stale process can continue
  writing even after losing ownership.
- Consider a single long-lived Work state owner only if direct multiple-CLI
  hosts cannot provide acceptable correctness/latency.
- Do not add a second Work database, distributed scheduler, independent
  team controller or broad isolation system on speculation.

Current implementation is a **trusted, single-operator prototype**.
This page addresses correctness and durability, **not** the deferred
container/egress-security program.

See [Brainstorm contract](brainstorm-composition.md) and
[Research review](../research/RES-0007-brainstorm-and-concurrency-review.md).
