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

**Status:** accepted and built (milestone W, steps W1, W2, W5, W7, W8 and W9, 2026-11-07; known defects fixed in WW1 and the review of WW1 in WW1c; moved to its own optional row `web-worker` in WW2a, 2026-11-07).

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
   (`packages/web-worker/src/chrome.ts`): the configured `executablePath`, then
   `CHROME_PATH`, then a system Chrome no older than the engine's Chromium,
   then the pinned Chrome for Testing (`chrome.lock.json`), installed with
   `@puppeteer/browsers` under `$DSH_HOME/system/browsers` the first time it is
   needed. It is launched per attempt on the persistent profile, with no
   ChatGPT-specific dependency. It runs in the Host: a
   browser is a long-lived resource the Host can keep between attempts.
   **Not enabled in the bundle**; the runbook says how to add it.
   **Never headless** (operator, 2026-11-07). System always runs a real,
   headed Chrome on an invisible display, a private Xvfb that it starts and
   stops (`packages/web-worker/src/display.ts`). The option `headless` does not
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
   `workers.loginWait` (all `agent: false`; `workers.recheck` checks an Account afterwards, WW6d). Three ways:
   - `--cookies`: a session cookie export (JSON or Netscape) from the
     operator's own browser, read once by the CLI into the profile and stored
     nowhere else. The browser is the same headed one, on its own Xvfb.
   - With neither, a visible window opens when the Host has a `DISPLAY`.
   - `--remote`, for a machine with no display (the operator's, checked
     2026-11-07), which also lets the operator clear a Cloudflare challenge
     that the cookies did not carry (W2).
   **The remote flow** (`packages/web-worker/src/remote-login.ts`, W9; a port of
   System 1's remote login) shows the **whole screen** of a private Xvfb through
   a VNC server and noVNC, reachable only through an owner-only unix socket and
   a loopback listener under a random token, over an SSH tunnel the operator
   opens; the operator signs in, clears any check by hand and presses **Save**.
   The steps are in the [web-worker README](../../packages/web-worker/README.md).
   System never solves or clicks a challenge; the human does, in the viewer.
   **Why VNC (reversed, W9).** W2 built a CDP screencast of one tab with
   CDP-dispatched input. The operator's evidence of 2026-11-07 refuted it: a
   restored tab left the screencast blank, its canvas did not fit the window,
   and Cloudflare Turnstile looped on the dispatched clicks. `x11vnc` 0.9.16
   has no unix-socket-only mode, so it runs once per connection with `-inetd`
   behind a socket the Host listens on: no TCP port is opened at all.
3. **One attempt.**
   1. Open a **temporary chat** (W7: System 1's driver turns the page's own
      Temporary chat control on; `?temporary-chat=true` is not used, see item
      7), the Account option `temporaryChat`, on by default: the account's memory
      and history do not leak into the answer, so attempts stay independent,
      and the operator's history is not filled with Worker chats. System keeps
      the exchange as a `conversation@1`, whose manifest records whether the
      chat was temporary.
   2. Send one prompt, built as for the CLI Workers: the step and Task
      instructions, the inputs inlined as text with their names, and the
      required outputs.
   3. Wait for completion (the driver's): the newest turn's finished marker
      appears and Stop is gone, then the text stays unchanged for `stable`
      seconds.
   4. Extract the answer as Markdown (the page's own Copy, checked against the
      rendered words) and the cited links. Output
      slots are filled from labelled blocks the prompt asks for (such as
      `report` and `sources`), each as a line `~~~~<name>`, the output, a line
      `~~~~` and nothing after the last (WW5c; a tilde fence is closed only by
      tildes, so code fences inside never end it); a missing block fails the
      attempt, as a missing file does today, and so does an answer that holds
      more than `maxOutsideChars` (200) characters outside its blocks, since an
      output may then be cut short. When the site shows the fences as paragraph
      text and its Copy escapes the Markdown (`\~`, `https\://`; seen live
      2026-11-08, WW5d), slots are read from the answer's rendered text by the
      same rules; escaped Markdown never fills one.
   5. The page logic is the Account option `procedures` (WW2-iii): `legacy`, System 1's
      driver (default), or `generic`, the generic Procedures bound to the ChatGPT map,
      so both can be compared on the real site before the legacy path goes. The
      attempt around them is the same. `generic` reads no Markdown (the rendered
      text and its labelled blocks only), reads no model, and fails a send it cannot
      confirm as "send outcome unknown: not resent", never resending it.
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
6. **A genuine browser (W5, 2026-11-07).** Evidence from the real site: a
   signed-in account was reported as challenged, and on another Cloudflare
   Turnstile looped however often the operator ticked it, because Playwright's
   defaults advertised automation (`--enable-automation`, `navigator.webdriver`)
   on an old Chromium. W5 ports System 1's principle (`docs/design/browser-runtime.md`,
   "a genuine browser, headed but invisible"): remove automation leaks only; no
   user-agent override, no fingerprint spoofing, never solve a challenge. So
   `patchright-core` launches Chrome headed, on the private Xvfb, with System 1's
   `CHROME_ARGS` and `ignoreDefaultArgs`, a real 1280x900 window and the last
   session restored. Page state follows System 1's `checkAuth` (a **visible**
   composer is signed in; a challenge counts only while visible). Before typing,
   **Chat** is pressed in the "Composer mode" group, and a composer whose label
   names Work is refused: Work spends the Codex quota. Not verified against the
   real site from here: the operator runs it.
7. **System 1's driver, ported whole (W7, 2026-11-07; operator's decision,
   said twice).** System 1 already works against chatgpt.com, so its logic is
   ported, not written again. W5 and W6 re-implemented parts with a small
   selector table and met problems System 1 had fixed: a stale send selector,
   `?temporary-chat=true` navigation aborted by the site, and a false
   challenge. `packages/web-driver` holds System 1's UI engine
   (`packages/ui-ops`), its ChatGPT driver and UI map
   (`packages/plugins/provider-chatgpt-web`) and the few parts of
   `provider-core` and `libs` they import, each file headed with its source
   path and commit, and the package README lists every difference. The
   Runtime now only launches the browser, builds the prompt and records the
   exchange; `checkAuth`, `open` (Chat mode, Temporary chat), `ask` and the
   answer read are the driver's, and the remote login's Save check is its
   `checkAuth`. What the driver reports goes to the attempt's log; self-heal
   is off (no decision store exists). Not verified against the real site from
   here: the operator's agent runs `SYSTEM_REAL_WEB=1 node --test
   tests/real-web.test.ts` after the merge. That run (2026-11-07) worked
   through the whole turn, but the answer was the page's rendered text, a code
   block as its header and content with no fence, so no output block was
   found. W8: the answer keeps its fences; where Copy does not give them, each
   rendered code block is fenced again from the page (`pre code`, its header
   as the info string).
   Later findings from live runs (code fences breaking the output blocks, a
   site-side generation error, a leaked `<escape>` token, the account circuit
   breaker `ready | cooling | needs-sign-in | challenged` and `system workers
   recheck`) are decided in code and described in the
   [web-worker README](../../packages/web-worker/README.md); git has the history.

## Tests and what is still to verify

System 1's fake site (`packages/web-driver/tests/fake-chatgpt.ts`, ported with
the driver, driven by `packages/web-worker/tests/chatgpt.test.ts` and
`tests/chatgpt-web.test.ts`) covers send, wait and extract, a sign-in wall, a
CAPTCHA page, the logged-out home, the site's error page, a composer on Work,
a missing output block and cancel mid-answer, deterministically and without an
account. The ported engine tests are in `packages/web-driver/tests`. `packages/web-worker/tests/remote-login.test.ts` covers the
remote flow (token, frames, input, Save, Cancel, expiry, cleanup) and the
private Xvfb. A headed Chrome that cannot start is a failure of these tests,
not a skip (`test-support/headed.ts`; `SYSTEM_SKIP_HEADED=1` skips them on a
host with no Xvfb): they were skipped when `dev` went red, because Chrome
aborts with "Socket path too long" when `TMPDIR` is deep, as it is in the
verifier's throwaway HOME, and the check passed without running them. A real run, gated by `SYSTEM_REAL_WEB=1`
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
