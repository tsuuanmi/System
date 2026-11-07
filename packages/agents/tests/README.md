# @system/agents tests

[fake-agent.mjs](fake-agent.mjs) stands in for `claude -p` and `codex exec`;
markers in the task's instructions (`FAKE:edit`, `FAKE:sleep`, ...) choose
what it does; it records the model flag it was given and, for `--output-format stream-json`, prints events as lines (`FAKE:followup`: two results); `FAKE:grandchild`/`FAKE:escaped` start descendants for the time-limit kill tests. [agent.test.ts](agent.test.ts) runs the adapter with it against
a real git repository, including a Codex takeover of cancelled Claude work.

[chatgpt.test.ts](chatgpt.test.ts) runs the `chatgpt-web` Runtime against System 1's
fake ChatGPT site ([web-driver/tests/fake-chatgpt.ts](../../web-driver/tests/fake-chatgpt.ts); scenarios
are its options; the Chrome the Runtime chooses, headed on a private Xvfb; a Chrome that cannot start fails them, see [test-support](../../../test-support/README.md)).
Its WW1 tests seed a disposable profile with tabs and relaunch it after a clean close and after a SIGKILL, check the one-working-tab invariant (a late page is closed too), the launch clock (a launcher that never returns, and one that fails) and the evidence record of good, failed, cancelled and timed-out attempts. [fake-chatgpt/](fake-chatgpt) is a small page for the remote sign-in tests only.
[chrome.test.ts](chrome.test.ts) covers the Chrome choice and its install with an injected installer. [remote-login.test.ts](remote-login.test.ts)
runs the remote sign-in against that page over a real Xvfb and VNC server
(skipped with the reason where there is none): the token, the WebSocket reaching
the VNC socket of the whole screen, real pointer input reaching the page, Save,
Cancel, expiry, and that Xvfb, the VNC server and the browser are gone after;
and the failure at once without a VNC server on `PATH`, an attempt on its own Xvfb, Xvfbs started together from one display number, and the `unavailable` account
without Xvfb or with `headless`.

The booted profile is covered by [tests/agents.test.ts](../../../tests/README.md),
and the real CLIs by the credential-gated `tests/real-agents.test.ts`
(the website by `tests/real-web.test.ts`).
