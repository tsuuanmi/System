# @system/work tests

- `workflow.test.ts` — both repository Workflow files, and every preflight refusal.
- `controller.test.ts` — the controller over the shared in-memory Work table
  (durable before visible, like DSH); includes a second controller taking
  over a Work whose first host died mid-attempt, verdict binding, pinned
  criteria and verifier versions, a crash during admission, and hosts whose
  snapshot is older than the Work (`run`, `retry`, `cancel` and `decide`
  refused, also after a host died between its update and its second mark; a
  Work with no mark, and a host retrying its own Work, run).
- `seam.test.ts` — the controller's dispatch, execute and observe phases
  with the [fixture](../../../test-support/README.md): Brainstorm and Software
  Engineering event sequences, a cancel request while an attempt is held at a
  barrier, and seeds 1 to 50 of random delays (replay matches, no event lost
  or repeated).
- `host-lock.test.ts` — the Host lock: a second lock on a home refused (also by
  symlink), another home free, release and a SIGKILLed child freeing it at
  once, the off-Linux and missing-home errors.
- `host.test.ts` — the Host over the fixture: the lane (ordering, no
  overlapping writes, a cancel racing a held attempt, seeds 1 to 20, a closed
  Host writing nothing), `commandId` receipts (one Work, one dispatch,
  refusal on different arguments, kept in the record across a restart) and
  recovery (attempt lost, nothing run by itself, an explicit run continues,
  effects reconciled).
- `effects.test.ts` — effect steps with a scripted remote: intent before
  effect, reconciliation after a lost host or a throw, the unknown-outcome
  hold and its resumption, approval and denial, retrying only the effect.
- `control.test.ts` — `FileControl`: one live holder, stale locks, a lock
  still being published (no pid yet) never taken as stale, cancel requests,
  a lock replaced by a live holder during a takeover surviving, a reused pid,
  a leftover takeover mutex, processes racing for a free or a stale lock, and
  the last-write mark
  (host and time) that fences stale hosts.
- `conversation.test.ts` — `conversation@1`: a manifest over stored parts,
  stable IDs, corrections, the preview and its secret warnings, and a task's
  context.
- `summary.test.ts` — operator touches and usage from a Work's events.

Shared stand-ins come from [test-support](../../../test-support/README.md).

The booted profile is covered by [tests/work.test.ts](../../../tests/README.md).
