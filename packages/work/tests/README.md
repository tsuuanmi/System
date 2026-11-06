# @system/work tests

- `workflow.test.ts` — both repository Workflow files, and every preflight refusal.
- `controller.test.ts` — the controller over the shared in-memory Work table
  (durable before visible, like DSH); includes a second controller taking
  over a Work whose first host died mid-attempt, verdict binding, pinned
  criteria and verifier versions, a crash during admission, and hosts whose
  snapshot is older than the Work (`run` and `retry` refused).
- `effects.test.ts` — effect steps with a scripted remote: intent before
  effect, reconciliation after a lost host or a throw, the unknown-outcome
  hold and its resumption, approval and denial, retrying only the effect.
- `control.test.ts` — `FileControl`: one live holder, stale locks, a lock
  still being published (no pid yet) never taken as stale, cancel requests,
  processes racing for a free or a stale lock, and the count of events
  written that fences stale hosts.
- `conversation.test.ts` — `conversation@1`: a manifest over stored parts,
  stable IDs, corrections, the preview and its secret warnings, and a task's
  context.
- `summary.test.ts` — operator touches and usage from a Work's events.

Shared stand-ins come from [test-support](../../../test-support/README.md).

The booted profile is covered by [tests/work.test.ts](../../../tests/README.md).
