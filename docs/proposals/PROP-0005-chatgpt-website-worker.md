---
id: PROP-0005
type: proposal
status: accepted
created: 2026-11-06
summary: A Website Worker that runs a step in the operator's signed-in ChatGPT web session through a genuine headed Chrome (patchright-core), returns the answer and its cited links as Artifacts, and records each exchange as a conversation; built on the Host after milestone H's checkpoint R1.
evidence: [RES-0008]
related: [PROP-0004, ADR-0004, ADR-0005, ADR-0007]
---

# Proposal: the ChatGPT Website Worker

**Status:** accepted and built (milestone W, steps W1, W2, W5, W7, W8 and W9, 2026-11-07; known defects fixed in WW1 and
the review of WW1 in WW1c; moved to its own optional row `web-worker` in WW2a, 2026-11-07).

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
  On 2026-11-07 the operator extended this to both accounts
  (`chatgpt-web/default` and `chatgpt-web/second`) and to regular unattended
  use, scheduled canaries included (milestone WW).

Because the ChatGPT-specific drivers have no license, System does not copy
their code. It may learn from their approach, such as recognising that an
answer is complete when its copy button appears, with a content-stability
fallback.

## Proposal and what was built

1. **A third Runtime**, `chatgpt-web`, beside Claude Code and Codex, in
   `packages/web-worker/src/chatgpt.ts` (its own package and optional, off-by-default `web-worker`
   row since WW2a: with the row off the account is `unavailable`, "the web-worker row is disabled"):
   an Account `chatgpt-web/<name>` of the
   `agents` row (default `chatgpt-web/default`) with the capabilities
   `research`, `brainstorm.idea-*` (by role) and `web-search`. It drives the
   page with `patchright-core` 1.63.0 (Apache-2.0, the version System 1 pins;
   W5 replaced `playwright-core`) on a Chrome chosen as in System 1
   (`packages/web-worker/src/chrome.ts`; the order is in the
   [web-worker README](../../packages/web-worker/README.md)), installed under
   `$DSH_HOME/system/browsers` the first time it is
   needed. It is launched per attempt on the persistent profile, with no
   ChatGPT-specific dependency. It runs in the Host: a
   browser is a long-lived resource the Host can keep between attempts.
   **Not enabled in the bundle**; the runbook says how to add it.
   **Never headless** (operator, 2026-11-07): a real, headed Chrome on the operator's `DISPLAY` or a private Xvfb
   (`packages/web-worker/src/display.ts`), because it is closer to the operator's own and is challenged less. The option
   `headless` does not exist, and an account that sets it is `unavailable`, as is one without Xvfb on `PATH`.
2. **The session.** A dedicated browser profile under
   `$DSH_HOME/system/chatgpt-web/<account>/`, owner-only and outside any
   sync, is the Account's credential and, like a token, never reaches other
   Workers. The operator signs in once with
   `system workers login chatgpt-web/<name> [--cookies <file> | --remote]`,
   the Host operations `workers.login`, `workers.loginRemote` and
   `workers.loginWait` (all `agent: false`; `workers.recheck` checks an Account afterwards, WW6d). Three ways:
   - `--cookies`: a session cookie export (JSON or Netscape) from the
     operator's own browser, read once by the CLI into the profile and stored
     nowhere else. The browser is the same headed one, on its own Xvfb.
   - With neither, a visible window opens when the Host has a `DISPLAY`.
   - `--remote`, for a machine with no display (the operator's, checked
     2026-11-07), which also lets the operator clear a Cloudflare challenge
     that the cookies did not carry (W2).
   **The remote flow** (`packages/web-worker/src/remote-login.ts`, W9; a port of System 1's remote login) shows the
   whole screen of a private Xvfb through VNC and noVNC over an SSH tunnel the operator opens; the operator signs in,
   clears any check by hand and presses **Save**. The steps are in the
   [web-worker README](../../packages/web-worker/README.md).
   System never solves or clicks a challenge.
   **Why VNC (reversed, W9).** W2's CDP screencast of one tab was refuted on
   2026-11-07 (blank restored tab, canvas not fitting, Turnstile looping on
   dispatched clicks). `x11vnc` has no unix-socket-only mode, so it runs once per
   connection with `-inetd` behind a socket the Host listens on: no TCP port opens.
3. **One attempt.**
   1. Open a **temporary chat** (W7: System 1's driver turns the page's own
      Temporary chat control on; `?temporary-chat=true` is not used, see item
      7), the Account option `temporaryChat`, on by default: the account's memory
      and history do not leak into the answer, so attempts stay independent,
      and the operator's history is not filled with Worker chats. System keeps
      the exchange as a `conversation@1`, whose manifest records whether the
      chat was temporary.
   2. Send one prompt, built as for the CLI Workers: the step and Task instructions, the inputs inlined as text with
      their names, and the required outputs.
   3. Wait for completion (the driver's: the finished marker, Stop gone, the text unchanged for `stable` seconds).
   4. Extract the answer and the cited links into the output slots, filled from labelled blocks the prompt asks for; a
      missing block fails the attempt, as a missing file does. The rules (fences, `maxOutsideChars`, rendered text)
      are in the [web-worker README](../../packages/web-worker/README.md); its Procedures are the only page logic.
4. **Provenance.** Each attempt also stores the exchange as a
   `conversation@1` (the contract is in [artifact verification](../architecture/artifact-verification.md)): the
   prompt and response as parts, the conversation URL, the model the driver
   read back and the cited hrefs as the attachment `links.json`. System
   observed the exchange itself, so the producer is the Worker attempt, not
   the operator. Usage is `unknown`: the web UI shows no token counts.
5. **Limits and failure.** One attempt at a time per Account (the Host's slots,
   PROP-0004 C3) and a timeout per stage (load, answer; W7 dropped `send`, the
   driver bounds each action itself). A sign-in wall,
   a CAPTCHA or an unknown page state fails the attempt with that reason and
   keeps a screenshot as partial output; it never hangs and never tries to get
   round a check. The page is System 1's: its UI map, UI engine and driver
   (item 7), not a selector table of this repository.
6. **A genuine browser (W5, 2026-11-07).** Cloudflare challenged accounts because Playwright's defaults advertised
   automation. W5 ports System 1's principle ("a genuine browser, headed but invisible"): remove automation leaks only,
   no fingerprint spoofing, never solve a challenge. **Chat** is pressed before typing and a composer that names Work is
   refused: Work spends the Codex quota. The code is in the [web-worker README](../../packages/web-worker/README.md).
7. **System 1's driver, ported whole (W7, 2026-11-07; operator's decision).** W5 and W6 re-implemented parts with a
   small selector table and met problems System 1 had fixed. `packages/web-driver` holds its UI engine, ChatGPT driver
   and UI map, each file headed with its source path and commit; its README lists every difference. The Runtime only
   launches the browser, builds the prompt and records the exchange. Self-heal is off (no decision store). Later
   findings from live runs are in the
   [web-worker README](../../packages/web-worker/README.md); git has the history.

## Tests and what is still to verify

System 1's fake site (`packages/web-driver/tests/fake-chatgpt.ts`) and
`packages/web-worker/tests` cover the exchange, the remote flow and the private
Xvfb deterministically and without an account. A headed Chrome that cannot start
is a failure, not a skip (`test-support/headed.ts`; `SYSTEM_SKIP_HEADED=1` skips
them on a host with no Xvfb). A real run, gated by `SYSTEM_REAL_WEB=1`
(`tests/real-web.test.ts`), is a Research Work on `chatgpt-web/default` whose
sources the citation verifier checks.

**Still to verify against the real site:** whether web search, model choice
and cited sources work in a temporary chat, and whether the operator's custom
instructions apply. The selectors are those the site used when this was
written, not checked on a live page (the UI map's own `uiRevision` is
2026-10-11, System 1's last check).

## Out of scope

Other websites; automating sign-in; getting round bot checks (the human clears one); a headless mode; uploading files;
the ChatGPT API, which needs an API key the operator does not have. Codex with
`--search`, the official route through the same subscription, stays available
as a separate option.
