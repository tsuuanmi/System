# @system/agents tests

[fake-agent.mjs](fake-agent.mjs) stands in for `claude -p` and `codex exec`;
markers in the task's instructions (`FAKE:edit`, `FAKE:sleep`, ...) choose
what it does; it records the model flag it was given and, for `--output-format stream-json`, prints events as lines (`FAKE:followup`: two results); `FAKE:grandchild`/`FAKE:escaped` start descendants for the time-limit kill tests. [agent.test.ts](agent.test.ts) runs the adapter with it against
a real git repository, including a Codex takeover of cancelled Claude work.

[chatgpt.test.ts](chatgpt.test.ts) runs the `chatgpt-web` Runtime against System 1's
fake ChatGPT site ([web-driver/tests/fake-chatgpt.ts](../../web-driver/tests/fake-chatgpt.ts); scenarios
are its options; the Chrome the Runtime chooses, headed on a private Xvfb; a Chrome that cannot start fails them, see [test-support](../../../test-support/README.md)).
[fake-chatgpt/](fake-chatgpt) is a small page for the remote sign-in tests only.
[chrome.test.ts](chrome.test.ts) covers the Chrome choice and its install with an injected installer. [remote-login.test.ts](remote-login.test.ts)
runs the remote sign-in against that page (token, a screencast frame over
SSE, a click and a key reaching the page, Save, Cancel, expiry and cleanup of
Xvfb and the browser), an attempt on its own Xvfb, Xvfbs started together from one display number, and the `unavailable` account
without Xvfb or with `headless`.

The booted profile is covered by [tests/agents.test.ts](../../../tests/README.md),
and the real CLIs by the credential-gated `tests/real-agents.test.ts`
(the website by `tests/real-web.test.ts`).

- [acp.test.ts](acp.test.ts) — optional Rust ACP bridge account invocation, strict parser, permission refusal and fake WorkerPort/Artifact capture (no model credentials).
