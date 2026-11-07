# Fake ChatGPT page

[index.html](index.html) and [chat.js](chat.js): a page with the selector roles
of `SELECTORS` in [chatgpt.ts](../../src/chatgpt.ts). The query string picks a
scenario (`normal`, `late-copy`, `early-copy`, `links`, `signin`, `captcha`,
`blank`, `session`, `forever`, `slow-session`, `logged-out-home`, `hidden-challenge`), the composer `mode` (`work`, `stuck`, `label`: see chat.js), the answer's `slots`, an `omit`ted block and the
`delay` between chunks; `model=none` hides the model label. [serve.mjs](serve.mjs) serves it from its own process.
