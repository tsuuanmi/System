# Fake ChatGPT page

[index.html](index.html) and [chat.js](chat.js): a small page for the remote
sign-in tests ([remote-login.test.ts](../remote-login.test.ts)): a signed-out
page whose "Log in" button sets the session cookie, a composer once it is
set, and a report of every load, click and key to `POST /event`. The
Runtime's attempts run against System 1's stand-in for chatgpt.com,
[fake-chatgpt.ts](../../../web-driver/tests/fake-chatgpt.ts).
