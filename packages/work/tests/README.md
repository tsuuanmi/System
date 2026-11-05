# @system/work tests

- `workflow.test.ts` — both repository Workflow files, and every preflight refusal.
- `controller.test.ts` — the controller over an in-memory table that, like
  DSH, is durable before it is visible; includes a second controller taking
  over a Work whose first host died mid-attempt.

The booted profile is covered by [tests/work.test.ts](../../../tests/README.md).
