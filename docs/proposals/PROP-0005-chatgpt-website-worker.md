---
id: PROP-0005
type: proposal
status: accepted
created: 2026-11-06
summary: A Website Worker that runs a step in the operator's signed-in ChatGPT web session through Playwright, returns the answer and its cited links as Artifacts, and records each exchange as a conversation; built on the Host after milestone H's release R1.
evidence: [RES-0008]
related: [PROP-0003, PROP-0004, ADR-0004, ADR-0005, ADR-0007]
---

# Proposal: the ChatGPT Website Worker

**Status:** accepted and built (milestone W, steps W1 and W2, 2026-11-07).

## Decision context

The operator does research and brainstorming in ChatGPT on the web and wants
System to use it as a Worker (operator, 2026-11-06). Three research Works
informed this proposal. Their verdicts were inconclusive because of
quote-formatting mismatches, so they are to be re-run after the verifier
fix V1; their content is used here as reference.

- `work:849abdee` (tokens and cost): not needed for this proposal.
- `work:e8677000` (existing projects): the ChatGPT-specific open-source
  drivers (chatgpt-proxy, chatgpt-mcp, chatgpt-cdp-mcp, chatgpt-web-mcp and
  chatgpt-browser-agent) are small, new and mostly **unlicensed**, and none
  extracts cited sources. General-purpose bases exist: Playwright and
  Playwright MCP, Chrome DevTools MCP, and browser-use.
- `work:179dde7d` (risks): OpenAI's Terms of Use (December 2024 text, read
  through a mirror) list "Automatically or programmatically extract data or
  Output" among the things users may not do, which puts the account at risk.
  Other risks are Cloudflare bot checks, UI changes, and a signed-in browser
  profile that must be guarded like a password. **The operator accepted these
  risks for their own account.**

Because the ChatGPT-specific drivers have no license, System does not copy
their code. It may learn from their approach, such as recognising that an
answer is complete when its copy button appears, with a content-stability
fallback.

## Proposal and what was built

1. **A third Runtime**, `chatgpt-web`, beside Claude Code and Codex, in
   `packages/agents/src/chatgpt.ts`: an Account `chatgpt-web/<name>` of the
   `agents` row (default `chatgpt-web/default`) with the capabilities
   `research`, `brainstorm.idea-*` (by role) and `web-search`. It drives the
   page with `playwright-core` 1.64.1 (Apache-2.0) on the installed Google
   Chrome, launched per attempt on the persistent profile, with no browser
   download and no ChatGPT-specific dependency. It runs in the Host: a
   browser is a long-lived resource the Host can keep between attempts.
   **Not enabled in the bundle**; the runbook says how to add it.
   **Never headless** (operator, 2026-11-07). System always runs a real,
   headed Chrome on an invisible display, a private Xvfb that it starts and
   stops (`packages/agents/src/display.ts`). The option `headless` does not
   exist, and an account that sets it is `unavailable`. The reason: a real
   headed browser is closer to the operator's own and is challenged less. Each
   attempt and each login uses the operator's `DISPLAY` when one is set, and
   otherwise its own Xvfb, stopped with the attempt (on cancel and on the time
   limit too). Other local users cannot reach it: it takes an X authority
   cookie kept in a directory of mode 0700 and listens on no TCP port. Without
   Xvfb on `PATH` the account is `unavailable` in `system workers`, with a
   reason that names it.
2. **The session.** A dedicated browser profile under
   `$DSH_HOME/system/chatgpt-web/<account>/`, owner-only and outside any
   sync, is the Account's credential and, like a token, never reaches other
   Workers. The operator signs in once with
   `system workers login chatgpt-web/<name> [--cookies <file> | --remote]`,
   the Host operations `workers.login`, `workers.loginRemote` and
   `workers.loginWait` (all `agent: false`). Three ways:
   - `--cookies`: a session cookie export (JSON or Netscape) from the
     operator's own browser, read once by the CLI into the profile and stored
     nowhere else. The browser is the same headed one, on its own Xvfb.
   - With neither, a visible window opens when the Host has a `DISPLAY`.
   - `--remote`, for a machine with no display (the operator's, checked
     2026-11-07), which also lets the operator clear a Cloudflare challenge
     that the cookies did not carry (W2).
   **The remote flow, as built** (`packages/agents/src/remote-login.ts`; the
   idea is System 1's "remote" flow, in pure Node):
   1. The Host starts a private Xvfb and opens the account's profile headed on
      it, with Playwright's default pipe (no CDP port exists), and loads
      chatgpt.com.
   2. It serves a viewer on `127.0.0.1` on a random port, under a random
      32-byte token in the path; a request without the token gets 403.
   3. The page shows a CDP screencast of the tab (`Page.startScreencast`),
      streamed with Server-Sent Events, and sends the operator's clicks,
      scrolls and keys back as POSTs that become `Input.dispatchMouseEvent` and
      `Input.dispatchKeyEvent`, scaled from the canvas to the page's pixels.
   4. The CLI prints the line `ssh -L <port>:127.0.0.1:<port> <user>@<host>`
      and the URL. The operator opens the tunnel from their own machine, opens
      the URL, signs in, clears any check by hand, and presses **Save**.
   5. On Save the browser closes cleanly, so the profile keeps `cf_clearance`
      and the session; then the signed-in check of a normal login runs and its
      result is reported. **Cancel**, Ctrl-C in the CLI, or 15 minutes, end the
      session without a check. Either way the browser, the Xvfb and the server
      are stopped.
   System never solves or clicks a challenge; the human does, in the viewer.
   **Why not VNC:** `x11vnc` and noVNC/websockify are not installed here, and
   a VNC server adds an extra listener and another password to guard. The
   screencast needs only Node and the Chrome already in use, and the token
   plus the loopback bind plus SSH are the whole access control.
3. **One attempt.**
   1. Open a **temporary chat** (`https://chatgpt.com/?temporary-chat=true`),
      the Account option `temporaryChat`, on by default: the account's memory
      and history do not leak into the answer, so attempts stay independent,
      and the operator's history is not filled with Worker chats. System keeps
      the exchange as a `conversation@1`, whose manifest records whether the
      chat was temporary.
   2. Send one prompt, built as for the CLI Workers: the step and Task
      instructions, the inputs inlined as text with their names, and the
      required outputs.
   3. Wait for completion: the newest turn's copy action appears, then the
      text stays unchanged for `stable` seconds.
   4. Extract the answer as Markdown and the cited links from the DOM. Output
      slots are filled from labelled, fenced blocks the prompt asks for (such
      as `report` and `sources`); a missing block fails the attempt, as a
      missing file does today.
4. **Provenance.** Each attempt also stores the exchange as a
   `conversation@1` ([PROP-0003](PROP-0003-conversation-ingestion.md)): the
   prompt and response as parts, the conversation URL, the model label the
   page showed and the cited hrefs as the attachment `links.json`. System
   observed the exchange itself, so the producer is the Worker attempt, not
   the operator. Usage is `unknown`: the web UI shows no token counts.
5. **Limits and failure.** One attempt at a time per Account (the Host's slots,
   PROP-0004 C3) and a timeout per stage (load, send, answer). A sign-in wall,
   a CAPTCHA or an unknown page state fails the attempt with that reason and
   keeps a screenshot as partial output; it never hangs and never tries to get
   round a check. Selectors live in one versioned table, `SELECTORS`, and the
   page is read with scripts instead of Playwright's `fill`, `click` and
   `waitForSelector`, which need a Chrome newer than the 95 installed on the
   operator's machine.

## Tests and what is still to verify

A fake page with the same structure (`packages/agents/tests/fake-chatgpt`,
driven by `packages/agents/tests/chatgpt.test.ts` and `tests/chatgpt-web.test.ts`)
covers send, wait and extract, completion detection, a sign-in wall, a CAPTCHA
page, a missing output block and cancel mid-answer, deterministically and
without an account. `packages/agents/tests/remote-login.test.ts` covers the
remote flow (token, frames, input, Save, Cancel, expiry, cleanup) and the
private Xvfb. Those tests are skipped, with the reason, where a headed Chrome
cannot start on an Xvfb (`test-support/headed.ts`). A real run, gated by `SYSTEM_REAL_WEB=1`
(`tests/real-web.test.ts`), is a Research Work on `chatgpt-web/default` whose
sources the citation verifier checks.

**Still to verify against the real site:** whether web search, model choice
and cited sources work in a temporary chat, and whether the operator's custom
instructions apply. The selectors are those the site used when this was
written, not checked on a live page.

## Out of scope

Other websites; automating sign-in; getting round bot checks (the human clears one); a headless mode; uploading files;
the ChatGPT API, which needs an API key the operator does not have. Codex with
`--search`, the official route through the same subscription, stays available
as a separate option.
