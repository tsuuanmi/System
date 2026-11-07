# @system/agents tests

[fake-agent.mjs](fake-agent.mjs) stands in for `claude -p` and `codex exec`;
markers in the task's instructions (`FAKE:edit`, `FAKE:sleep`, ...) choose
what it does; it records the model flag it was given and, for `--output-format stream-json`, prints events as lines (`FAKE:followup`: two results); `FAKE:grandchild`/`FAKE:escaped` start descendants for the time-limit kill tests. [agent.test.ts](agent.test.ts) runs the adapter with it against
a real git repository, including a Codex takeover of cancelled Claude work.

[chatgpt.test.ts](chatgpt.test.ts) runs the `chatgpt-web` Runtime against the
fake ChatGPT page in [fake-chatgpt/](fake-chatgpt) (static HTML plus `chat.js`; scenarios by
query string; the installed Chrome, headed on a private Xvfb; skipped, with
the reason, where it cannot start). [remote-login.test.ts](remote-login.test.ts)
runs the remote sign-in against the same page (token, a screencast frame over
SSE, a click and a key reaching the page, Save, Cancel, expiry and cleanup of
Xvfb and the browser), an attempt on its own Xvfb, and the `unavailable` account
without Xvfb or with `headless`.

The booted profile is covered by [tests/agents.test.ts](../../../tests/README.md),
and the real CLIs by the credential-gated `tests/real-agents.test.ts`
(the website by `tests/real-web.test.ts`).
