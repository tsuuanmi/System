---
id: PROP-0005
type: proposal
status: accepted
created: 2026-11-06
summary: A Website Worker that runs a step in the operator's signed-in ChatGPT web session through a genuine headed Chrome (patchright-core), returns the answer and its cited links as Artifacts, and records each exchange as a conversation; built on the Host after milestone H's checkpoint R1.
evidence: [RES-0008]
related: [PROP-0003, PROP-0004, ADR-0004, ADR-0005, ADR-0007]
---

# Proposal: the ChatGPT Website Worker

**Status:** accepted and built (milestone W, steps W1, W2, W5, W7, W8 and W9, 2026-11-07; known defects fixed in WW1 and the review of WW1 in WW1c).

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
   `packages/agents/src/chatgpt.ts`: an Account `chatgpt-web/<name>` of the
   `agents` row (default `chatgpt-web/default`) with the capabilities
   `research`, `brainstorm.idea-*` (by role) and `web-search`. It drives the
   page with `patchright-core` 1.63.0 (Apache-2.0, the version System 1 pins;
   W5 replaced `playwright-core`) on a Chrome chosen as in System 1
   (`packages/agents/src/chrome.ts`): the configured `executablePath`, then
   `CHROME_PATH`, then a system Chrome no older than the engine's Chromium,
   then the pinned Chrome for Testing (`chrome.lock.json`), installed with
   `@puppeteer/browsers` under `$DSH_HOME/system/browsers` the first time it is
   needed. It is launched per attempt on the persistent profile, with no
   ChatGPT-specific dependency. It runs in the Host: a
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
   **The remote flow, as built** (`packages/agents/src/remote-login.ts`,
   W9; a port of System 1's remote login, `packages/plugins/login/src/remote.ts`):
   1. Without `x11vnc` or `x0vncserver` on `PATH` it fails at once, naming
      both. Otherwise the Host starts a private Xvfb, a VNC server on it, and
      opens the account's profile headed on it (the engine's pipe: no CDP
      port exists), and loads chatgpt.com.
   2. The VNC server is reachable only through an owner-only unix socket in a
      directory of mode 0700 (no TCP port), and the Host serves noVNC
      (`@novnc/novnc`, served unmodified) on `127.0.0.1` on a random port,
      under a random 32-byte token in the path; a request without the token,
      or with a Host header other than loopback, gets 404, and a WebSocket on
      `<token>/websockify` is bridged to the VNC socket.
   3. The page shows the **whole screen** of that Xvfb, scaled to the browser
      window (`scaleViewport`), with real X input: every tab (a restored
      one too), the popups and a challenge's checkbox are there, and the
      browser sees what it sees from a person at a keyboard.
   4. The CLI prints the line `ssh -L <port>:127.0.0.1:<port> <user>@<host>`
      and the URL. The operator opens the tunnel from their own machine, opens
      the URL, signs in, clears any check by hand, and presses **Save**.
   5. On Save the browser closes cleanly, so the profile keeps `cf_clearance`
      and the session; then the signed-in check of a normal login runs and its
      result is reported. **Cancel** (accepted only from the page's own
      origin), Ctrl-C in the CLI, or 15 minutes, end the session without a
      check. Either way the browser, the VNC server, the Xvfb and the server
      are stopped.
   System never solves or clicks a challenge; the human does, in the viewer.
   **Why VNC (reversed, W9).** W2 built a CDP screencast of one tab with
   CDP-dispatched input, on the grounds that no VNC server was installed and
   that one adds a listener. The operator's evidence of 2026-11-07 refuted
   it: for `chatgpt-web/second` the profile had restored another tab (an
   `auth.openai.com` "Session ended" page) and the screencast, which shows only
   the page it attached to, was blank; its canvas did not fit the window; and
   Cloudflare Turnstile looped on the dispatched clicks. System 1's remote
   login, which works, shows the whole Xvfb screen through VNC and noVNC. The
   listener is a unix socket with owner-only access, and the token, the
   loopback bind and SSH remain the access control. `x11vnc` 0.9.16 has no
   unix-socket-only mode (System 1's `-unixsockonly`; its `-unixsock` also
   listens on TCP port 5900, with no password), so it is run once per
   connection with `-inetd` behind a socket the Host itself listens on:
   no TCP port is opened at all.
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
      output may then be cut short.
4. **Provenance.** Each attempt also stores the exchange as a
   `conversation@1` ([PROP-0003](PROP-0003-conversation-ingestion.md)): the
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
6. **A genuine browser (W5, 2026-11-07).** Evidence from the real site: an
   account that was signed in was reported as challenged (a false positive of
   a check that looked at the DOM, not at what shows), and on another account
   Cloudflare Turnstile ("Verify you are human") looped however often the
   operator ticked it. The first launch used Playwright's defaults, so the
   browser advertised automation (`--enable-automation`, `navigator.webdriver`)
   and ran with `--no-sandbox`, `--password-store=basic` and
   `--use-mock-keychain`, on a Chromium 136 build of 2025. System 1 does not,
   and works. W5 ports its principle (`docs/design/browser-runtime.md`, "a
   genuine browser, headed but invisible"): remove automation leaks only; no
   user-agent override, no fingerprint spoofing, never solve a challenge. So
   `patchright-core` launches Chrome headed, on the private Xvfb, with
   System 1's `CHROME_ARGS` and `ignoreDefaultArgs` (`--no-sandbox`,
   `--password-store=basic`, `--use-mock-keychain`, `--enable-automation`),
   a real 1280x900 window instead of an emulated viewport, and the last
   session restored. Page state follows System 1's `checkAuth`: signed in is a
   **visible** composer (`[contenteditable="true"][data-composer-markdown]`
   first, never the logged-out home's own); a challenge counts only while it is
   **visible** (or the URL is under `/cdn-cgi/challenge-platform/`); the page is
   waited on, up to `load` seconds, for signed in, signed out, challenge or the
   site's error page; the logged-out shell is held 3 s before it counts as
   signed out. Before typing, **Chat** is pressed in the "Composer mode" group,
   and a composer whose label names Work is refused: Work spends the Codex
   quota. Save in the remote viewer stops Chrome cleanly and checks the sign-in
   in the same profile (a session is bound to it: never a copy).
   Not verified against the real site from here: the operator runs it. If a
   challenge still loops, the difference left is the input (above). *(W5
   wrote this logic again as a selector table and scripts; item 7 replaces
   that.)*
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
   WW5a: a review holding code is answered in a four-backtick fence, which
   the driver's three-backtick pairing broke (second opinions `work:d72ce675`
   and `work:a4bd030d` lost their `review` block); fences are read by
   CommonMark's rule and rebuilt one backtick longer than their content.
   WW5b: a second opinion (`work:feee282d`) was answered as one `review` widget
   whose text holds ```` ```ts ```` fences; the driver took those lines for
   Markdown and did not fence the widget. The driver now returns the rendered
   blocks as data and the Runtime fills each output from the block labelled
   with its name (verbatim; two such blocks are ambiguous and fail), else from
   the Markdown text; the evidence records which (`filled`).
   WW5c: a second opinion (`work:7f820cb2`) was accepted with a 339-byte
   `review`: ChatGPT wrapped it in a three-backtick fence although it holds
   ```` ```ts ````, the inner closing fence ended the block, and the page,
   the widget and the parser agreed on the truncated text. A bake-off on both
   Accounts chose four tildes (backtick fences passed once, `===BEGIN===`
   sentinels failed on both: Copy escapes them). The prompt asks for tilde
   fences, the parsers read them by CommonMark, and an answer with more than
   `maxOutsideChars` characters outside its output blocks fails, the answer
   kept as partial output (evidence `outsideChars`).

## Known defects, fixed in WW1 (2026-11-07)

- **Restored tabs.** A profile that had held 14 to 17 tabs reopened them all:
  5.5 GB, and on `second` Playwright's launch never returned within 60 s, so
  cleaning up after launch could not help. Measured: moving only `Default/Sessions`
  aside launched in 0.8 s, still signed in. The Runtime removes the tab sessions
  before each launch and marks the last exit clean, then keeps one working tab
  (its own, opened first). The preferences alone did not stop the restore: the
  launch keeps `--restore-last-session`, which outranks them and which keeps
  session-only cookies alive ([agents README](../../packages/agents/README.md)).
  Cancel and the time limit end Chrome with `context.close()`, and a SIGKILL
  relaunch is tested to open one tab.
- **Chat/Work switch not found.** The switch is awaited (a bounded setting of
  the UI map), then required to hold; a page that never shows it fails as
  `mode unknown`, and a challenge or sign-out is named as such. No selector
  changed: no failing page had been captured, and each failure now keeps the
  screenshot, a redacted DOM, the URL, the viewport and the map version.
- **A 1.5 s launch clock** in the Runtime's test was the page clock reused for
  Chrome's launch; the test never asserted the timeout. Chrome has its own
  `timeouts.launch` (30 s).
- **Evidence.** Each attempt writes a stage chain as it happens, before Chrome
  starts, with `promptSendAttempted` and `promptSubmitted`, and keeps it as
  partial output.

## Review findings of WW1, fixed in WW1c (2026-11-07)

A second opinion (`chatgpt-web/second`, Work `work:d72ce675`) reviewed the WW1 diff.
Fixed, each with a test that failed first:

- **D1, the failure DOM kept text.** The snapshot is now structure only: every text
  node and every attribute value but `role`, `aria-label` and `data-testid` is its
  length.
- **D2, a timed-out launch left Chrome running.** The process group that took the
  profile's lock is killed.
- **D3, a held profile was launched.** `launch` fails naming the live Chrome and
  leaves it alone.
- **D4, D5, the mode wait.** Bounded by its deadline as a whole, sampled every poll
  (a change that comes back restarts the hold), and the mode is read again right
  before the send.
- **D6, D7, D8, D9.** `close` is `ok` only when the browser process exited (one that
  outlives it is killed and the stage fails); `promptSendAttempted` is apart from
  `promptSubmitted`, which needs a user turn on the page; the conversation binding
  read belongs to the `read` stage, and the first failed stage stays the failed
  stage; closed pages are counted when confirmed, and a page that will not close
  fails the attempt.
- **Questions answered in the READMEs:** `close()` is the Playwright context's, and the
  process's exit is now checked (agents README); stages are in the evidence list.
- **Also found (WW1c):** typing a 66 KB prompt took 5.5 min, so the composer takes one
  paste event ([web-driver README](../../packages/web-driver/README.md)), recorded as
  the `insert` stage; and a Runtime waited for a Worker's pipes to close, which two
  leaked Xvfb held open for 33 min: the attempt now ends on process exit
  ([agents README](../../packages/agents/README.md)).
- **Also found (WW1g):** the paste of a 61,581-character prompt became an attachment chip on a
  Team workspace (the composer read 2 characters and the read-back failed) and stayed text on
  another account. A prompt is now a header typed in the composer and a body pasted after it,
  accepted as text or as one chip named by its start, else failed before the send in the stage
  `attach`; the evidence records the outcome and the chip count
  ([web-driver README](../../packages/web-driver/README.md),
  [agents README](../../packages/agents/README.md)).
- **Also found (WW1h, second opinion of WW1c, `work:ce23f210`):** fixed: a failed launch
  kills only a Chrome this process started (1); a close with no identified process is not
  `ok` (2); only a known mode can settle (3); each page operation of the mode wait ends at
  its deadline (4); a late page that will not close fails the one-tab invariant (5); the
  binding is checked inside the one `read` stage (6); the Xvfb leak test signals only the
  pid the verifier names (7). A failure names the stage that failed and its own limit
  ("open: page.goto timed out after 60 s"), not the answer clock.
- **Not fixed, as risks:** the lock check is not atomic; the `page` handler closes
  legitimate pop-ups; evidence writes that fail are silent; `skip`-gated headed tests
  depend on the environment.

## Tests and what is still to verify

System 1's fake site (`packages/web-driver/tests/fake-chatgpt.ts`, ported with
the driver, driven by `packages/agents/tests/chatgpt.test.ts` and
`tests/chatgpt-web.test.ts`) covers send, wait and extract, a sign-in wall, a
CAPTCHA page, the logged-out home, the site's error page, a composer on Work,
a missing output block and cancel mid-answer, deterministically and without an
account. The ported engine tests are in `packages/web-driver/tests`. `packages/agents/tests/remote-login.test.ts` covers the
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
