# @system/agents tests

[fake-agent.mjs](fake-agent.mjs) stands in for `claude -p` and `codex exec`;
markers in the task's instructions (`FAKE:edit`, `FAKE:sleep`, `FAKE:holdstdout` for a child that holds stdout open, ...) choose
what it does; it records the model flag it was given and, for `--output-format stream-json`, prints events as lines (`FAKE:followup`: two results); `FAKE:grandchild`/`FAKE:escaped` start descendants for the time-limit kill tests. [agent.test.ts](agent.test.ts) runs the adapter with it against
a real git repository, including a Codex takeover of cancelled Claude work.

[index.test.ts](index.test.ts) tests the seam to the web Runtime: a `chatgpt-web` account is unavailable
with "the web-worker row is disabled" when the row is off, and handed to its service when it is on.
The web Runtime's own tests are in [web-worker](../../web-worker/tests/README.md).

The booted profile is covered by [tests/agents.test.ts](../../../tests/README.md),
and the real CLIs by the credential-gated `tests/real-agents.test.ts`.
