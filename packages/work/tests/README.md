# @system/work tests

- `workflow.test.ts` — both repository Workflow files, and every preflight refusal.
- `controller.test.ts` — the controller over the shared in-memory Work table
  (durable before visible, like DSH); includes a second controller taking
  over a Work whose first host died mid-attempt, verdict binding, pinned
  criteria and verifier versions, and a crash during admission.
- `effects.test.ts` — effect steps with a scripted remote: intent before
  effect, reconciliation after a lost host or a throw, the unknown-outcome
  hold and its resumption, approval and denial, retrying only the effect.
- `control.test.ts` — `FileControl`: one live holder, stale locks, cancel
  requests, and two processes racing for a stale lock.
- `summary.test.ts` — operator touches and usage from a Work's events.

Shared stand-ins come from [test-support](../../../test-support/README.md).

The booted profile is covered by [tests/work.test.ts](../../../tests/README.md).
