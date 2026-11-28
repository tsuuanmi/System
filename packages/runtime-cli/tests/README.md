# @system/runtime-cli tests

[fake-agent.mjs](fake-agent.mjs) stands in for `claude -p` and `codex exec`;
markers in the task's instructions (`FAKE:edit`, `FAKE:sleep`, `FAKE:holdstdout` for a child that holds stdout open, ...) choose
what it does; it records the model flag it was given and, for `--output-format stream-json`, prints events as lines (`FAKE:followup`: two results); `FAKE:grandchild`/`FAKE:escaped` start descendants for the time-limit kill tests. [agent.test.ts](agent.test.ts) runs the adapter with it against
a real git repository, including a Codex takeover of cancelled Claude work.

[lifecycle.test.ts](lifecycle.test.ts) specifies the attempt lifecycle both Runtimes share (`src/lifecycle.ts`) with a stand-in turn:
the time limit and its reason, cancel with partial outputs, a missing declared output, the bounded log.

[index.test.ts](index.test.ts) tests the seam to the web Runtime: a `web` account is unavailable
with "the web-worker row is disabled" when the row is off, and handed to its service when it is on.
The web Runtime's own tests are in [web-worker](../../runtime-web/tests/README.md).

The booted profile is covered by [tests/agents.test.ts](../../../tests/README.md),
and the real CLIs by the credential-gated `tests/real-agents.test.ts`.

[quota.test.ts](quota.test.ts) specifies the sc-3 parsers, schemas (fixture [codex-0.171.0-rate-limits.json](codex-0.171.0-rate-limits.json), a real answer) and ten-minute cache;
[quota-read.test.ts](quota-read.test.ts) checks CLI protocols and process cleanup;
[quota-row.test.ts](quota-row.test.ts) checks per-account reads on the agents row.
The synthetic fixtures and CLIs live in [test-support](../../../test-support/README.md).
`FAKE:ratelimit=<five_hour|seven_day>:<fraction>` emits an attempt quota event
for the hook tests in `agent.test.ts`; `FAKE:unified=<five>,<seven>` emits both
fractional windows in `unifiedWindows` for the ro-2 hook test. These tests use no real CLI or account.

[ask.test.ts](ask.test.ts) checks `ask` (cls-1): one tool-less turn on the economy model of an Account that is not excluded, through the same fake CLI; `FAKE:cause=<label>` makes the fake answer a Classifier question.

[antigravity.test.ts](antigravity.test.ts) specifies the Antigravity Runtime from the real outputs in [fixtures/antigravity](fixtures/antigravity/README.md) (parse, limits, argv and env, the staged permission rules, the `/usage` reading) and runs two Accounts sharing one home at once with the fake agent (`--mode` makes it print `agy`'s events), plus `finish-1` structured-result outcomes from [fixtures/antigravity](fixtures/antigravity/README.md) and [fixtures/codex](fixtures/codex/README.md).
