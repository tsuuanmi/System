# @system/web-worker tests

Most of these run a real headed Chrome on Xvfb, so `corepack pnpm test` leaves them out; `corepack pnpm test:web` runs them.
[no-browser.test.ts](no-browser.test.ts) is the exception: it runs in `test` and shows that `SYSTEM_NO_BROWSER=1` refuses every browser launch.

[chatgpt.test.ts](chatgpt.test.ts) runs the `chatgpt-web` Runtime against System 1's
fake ChatGPT site ([web-driver/tests/fake-chatgpt.ts](../../web-driver/tests/fake-chatgpt.ts); scenarios
are its options; the Chrome the Runtime chooses, headed on a private Xvfb; a Chrome that cannot start fails them, see [test-support](../../../test-support/README.md)).
Its WW1 tests seed a disposable profile with tabs and relaunch it after a clean close and after a SIGKILL, check the one-working-tab invariant (a late page is closed too), the launch clock (a launcher that never returns, with its Chrome killed, and one that fails), a held profile that is never launched, a launch that fails while another Chrome holds the profile, a close that leaves the process or cannot identify it, a late page that will not close, the stage and limit a timeout names, send attempted against confirmed, and the evidence record of good, failed, cancelled and timed-out attempts. [fake-chatgpt/](fake-chatgpt) is a small page for the remote sign-in tests only.
[chatgpt-generic.test.ts](chatgpt-generic.test.ts) sets `procedures: generic` and loads that file again, so every attempt test runs for both page logics (the few that need Copy's Markdown or the model picker are skipped for `generic`, with the reason).
[health.test.ts](health.test.ts) (no browser, so it is in `corepack pnpm test`) covers the circuit breaker (WW6d): each transition, a failure of the Host's that leaves the state alone, one notice per change, the state surviving a restart, and routing that skips an Account in quarantine and uses the other; [chatgpt-health.test.ts](chatgpt-health.test.ts) runs it around attempts on the fake site (a sign-in wall, a challenge, a site error and a success, a failed launch) and covers the recheck (passes, fails on a wall or a challenge, a held profile).
[chrome.test.ts](chrome.test.ts) covers the Chrome choice and its install with an injected installer. [remote-login.test.ts](remote-login.test.ts)
runs the remote sign-in against that page over a real Xvfb and VNC server
(skipped with the reason where there is none): the token, the WebSocket reaching
the VNC socket of the whole screen, real pointer input reaching the page, Save,
Cancel, expiry, and that Xvfb, the VNC server and the browser are gone after;
and the failure at once without a VNC server on `PATH`, an attempt on its own Xvfb, Xvfbs started together from one display number, and the `register` refusal
without Xvfb or with `headless`.

The booted profile is covered by [tests/chatgpt-web.test.ts](../../../tests/README.md) (the row on), [tests/web-worker-off.test.ts](../../../tests/web-worker-off.test.ts) (the row off), and the website by the credential-gated `tests/real-web.test.ts`.
