# @system/web-worker

The `web-worker` row: the `chatgpt-web` Runtime, where an account is the
operator's own signed-in ChatGPT website session driven through a genuine
headed Chrome ([PROP-0005](../../docs/proposals/PROP-0005-chatgpt-website-worker.md)).
It is its own package and an **optional, off** row (WW2a, config-first
optionality): System's core and the CLI Runtimes of [@system/agents](../agents/README.md)
do not depend on it, are tested without it, and work when it is off. Its
browser dependencies (`patchright-core`, `@puppeteer/browsers`, `@novnc/novnc`,
`ws`, [`@system/web-driver`](../web-driver/README.md)) are this package's alone.

- **Injects:** `capabilities`, `artifacts`, `subprocess` (DSH).
  **Provides:** `ctx.webWorker`, the `WebWorkerService` contract that
  [`@system/agents`](../agents/src/web.ts) declares: `register` (an account), `login`, `loginRemote`, `loginWait`, `recheck`.
- **Accounts** stay in the `agents` row's `accounts` (`runtime: chatgpt-web`).
  The `agents` row hands each to `register`, which checks it (Xvfb, no `headless`, the Chrome, the settings), registers its Worker
  and keeps its sign-in state; `system workers` shows the result.
- **Registering (WW6e):** the Host serves while the `agents` row is still handing accounts over, so the row announces each
  `chatgpt-web` account (`expect`) before the first registration. `system workers` lists one not yet registered as
  `registering`; `login` and `login --remote` wait for it, at most `registerWaitSeconds` (row
  config, default 60) and then fail "still registering after N s". An account whose registration failed, before or after the operation came, is refused with that
  reason (`chatgpt-web/<name>: <reason>`), one not configured with "is not a configured chatgpt-web account". An attempt needs no
  wait: the Worker exists only once registered. [tests/accounts.test.ts](tests/accounts.test.ts) holds a registration open by hand.
- **Row off:** such an account is reported `unavailable` with the reason
  "the web-worker row is disabled", `system workers login` says the same, and none of
  this package is loaded.
- **Tests:** this package's tests drive a real headed Chrome, so they are outside `corepack pnpm test`
  and `smoke`: `corepack pnpm test:web` runs them (the `web` check of `.system/checks.yaml`).
  [tests/web-worker-off.test.ts](../../tests/web-worker-off.test.ts) (a smoke test) boots System with the row
  off and runs the main path on the fake Runtimes.
- **No browser in the default suites:** with `SYSTEM_NO_BROWSER=1` (set by the `test` and `smoke` scripts, not by `test:web`)
  every launch of Chrome or Xvfb (`chromeMajor`, `startXvfb`, `launch`, `startRemoteLogin`) throws
  "a browser launch was refused" before anything is spawned ([no-browser.ts](src/no-browser.ts), [tests/no-browser.test.ts](tests/no-browser.test.ts)).

```yaml
# $DSH_HOME/profiles/system/cordis.patch.yml
- id: web-worker
  disabled: false
  # config: {registerWaitSeconds: 60}   # how long an operation on an account waits for its registration
- id: agents
  config:
    accounts:
      # the bundle's accounts, plus:
      - ref: chatgpt-web/default
        runtime: chatgpt-web
        capabilities: [research, web-search]   # brainstorm.idea-<role> too, by role
        # all optional, with these defaults:
        profileDir: chatgpt-web/default        # under $DSH_HOME/system unless absolute; mode 0700
        temporaryChat: true                    # each attempt in a temporary chat
        url: https://chatgpt.com/
        executablePath: ...                    # default: CHROME_PATH, a recent system Chrome, else the managed Chrome for Testing
        timeouts: {load: 60, answer: 900, stable: 3}   # seconds; also launch (30) and mode (the UI map's own, 15)
        cooldownSeconds: [120, 300]            # cooldown after the 1st, 2nd... consecutive site error (see Account health)
        hostLoad: 8                            # 1-minute load average above which a page timeout is the Host's; default 2 x CPUs
```

## Accounts and attempts

An Account `chatgpt-web/<name>` runs one step as one prompt in the operator's
own signed-in ChatGPT web session ([PROP-0005](../../docs/proposals/PROP-0005-chatgpt-website-worker.md)).
It is in [chatgpt.ts](src/chatgpt.ts) (the sign-in is in [chatgpt-login.ts](src/chatgpt-login.ts)), drives a genuine headed Chrome with
`patchright-core` 1.63.0 (System 1's pin; [chrome.ts](src/chrome.ts) chooses the Chrome and installs the pinned Chrome for Testing on first use), and runs inside the Host,
not as a spawned process. The account is configured in the `agents` row like any other;
this row serves it (see above) and is off by default: [enable it](../../docs/operations/runbook.md#the-chatgpt-web-account).

One attempt:

1. **Launch** a persistent Chrome context on `profileDir`, **headed**: the
   profile is the Account's credential and is reused by every attempt. One
   attempt at a time per Account (Chrome locks the profile). The browser is
   never headless: it runs on the Host's `DISPLAY`, or when there is none on a
   private Xvfb ([display.ts](src/display.ts)) that the attempt starts and stops,
   also on cancel and on the time limit. Without Xvfb on `PATH` the Account is
   `unavailable`, with a reason naming it, and an account that sets `headless` is
   too, as is every account when the shipped UI map did not load (WW6f; one line, the first schema error). **No restored tabs (WW1):** before every launch `prepareProfile` sets the
   profile's startup preference to a new tab page, marks its last exit clean and
   removes its tab sessions (`Default/Sessions`); Cookies, Login Data, Local
   Storage, Session Storage and IndexedDB are never touched, and a profile a
   running Chrome holds is left alone, and `launch` refuses one: the attempt fails
   saying which Chrome (pid) holds it, and that Chrome is never touched. The preferences alone do not stop the
   restore, because the launch keeps `--restore-last-session` (it outranks them),
   and the flag has to stay: without it Chrome drops the profile's session-only
   cookies (measured on Chrome for Testing 155, 2026-11-07: preferences without
   the flag opened one tab and lost the cookie; with it six tabs came back;
   the flag with the sessions removed gave one tab and kept the cookie, after a
   clean close; after a SIGKILL Chrome has not written session cookies either
   way). The measured reason is that a profile with 17 restored tabs held
   Playwright's `launchPersistentContext` for the full 60 s, so cleaning up
   afterwards is too late. Then the worker's own tab is opened first, every
   other page is closed, and so is any that arrives later (the context's `page`
   event), before the first navigation. Chrome gets its own clock, `timeouts.launch`
   (30 s unless set), apart from the page clocks: a short page clock in a
   test measured the host's load, not the driver. A launch that fails, times out
   or is abandoned does not leave Chrome running: the process group that took
   the profile's lock since the launch began is killed only if this process
   started it (its parent is this process): a Chrome that took the profile
   some other way is never touched. A context that comes up late is closed. A page that will
   not close fails the attempt (a late one at the next check, before the
   first navigation and after the answer): the one-tab invariant is not
   claimed when it does not hold. A close is `ok` only when the browser
   process was identified and has exited.
2. **Open and send** through the generic Procedures
   ([web-driver](../web-driver/README.md#generic-procedures-ww2-ii-new-here)) bound to the
   ChatGPT map: `open` loads the site's home and `checkAuth` reads the page's state (up to
   `load` seconds; a visible composer is signed in; a challenge, the login page, the logged-out
   home held 3 s and the site's own error page are each their own failure), `openChat` and
   `ensureMode` select **Chat** (a composer that names Work is refused: Work spends the Codex
   quota) and, when `temporaryChat`, **Temporary chat** by the page's own control. System never
   types into or solves a challenge. `observeModel` and `selectPower` read and set the Power
   level (below), `insertInstructions` clears the composer and puts in the prompt built like the
   CLI prompt, with the inputs (and context) inlined as text, and each output slot asked for as a
   four-tilde fenced block labelled with its name (WW5c): at most 200 KiB. `attachText` adds the
   body of a two-part prompt, and `send` sends it. Nothing in the Runtime knows a selector: the UI
   map is the Procedures'.
3. **Wait** (`waitForAnswer`): the answer's finished marker and text unchanged for `stable`
   seconds, within `answer` seconds (no stall clock, only that deadline).
4. **Read** (`readAnswer`): the answer's rendered text, its code blocks with their labels and
   the links in it. There is no Markdown: the Procedures never press Copy.
5. **Drift:** what the Procedures report (a drifted element) goes to the attempt's log as counts
   and structure only. Self-heal is off: no decision store exists.
6. **Fill** each slot from the rendered block that carries its name (two of one name are
   ambiguous and fail the attempt), else from a labelled fenced block in the rendered text
   (backtick or tilde fences by CommonMark: a longer fence, or the other character, holds
   shorter ones; the first block of a name wins). A missing block fails the attempt; so does an
   answer with more than `maxOutsideChars` (account setting, default 200)
   characters outside its output blocks, whitespace ignored (WW5c: "the answer
   continues outside its output blocks (N characters): an output may be cut
   short", for a fence closed early by its own content). What was found stays
   as unaccepted partial output. When no rendered block gives any output (the site showed
   the fences as paragraph text, WW5d), the fences in the rendered text are read by the same
   rules, and `outsideChars` counts that text; text that is escaped Markdown (a line of
   escaped tildes or backticks, or `\:`) never fills an output. Otherwise `outsideChars`
   counts the page text outside the label and code of the blocks that fill outputs.
7. **Record** a `conversation@1`: `prompt.md` and `response.md` as parts,
   `links.json` (the cited hrefs) as an attachment, asserted `provider:
   ChatGPT`, the page `url` (no `model`: the Procedures select none) and `context: [ui-map:<uiRevision>, temporary-chat]` (the latter when
   used). Its
   producer is the Worker (the attempt observed the exchange). It is returned as
   the extra output `conversation` (the controller records only a step's
   declared slots) and as partial output `conversation`, which the observation
   records for a succeeded attempt too (WW6c). Usage is unknown. The log is the stage notes.

On any failure the page's screenshot is kept as partial output `screenshot`, with
`snapshot`: its URL (no query), the viewport, the UI map's revision and hash and
the DOM's structure, bounded to 20,000 characters: tags, attribute names, `role`,
`aria-label` and `data-testid` values, and every text node and other attribute
value replaced by its length (`[text:42]`); no cookie or storage is read. **Evidence (WW1):** each attempt makes a small JSON record before Chrome
launches ([evidence.ts](src/evidence.ts)) and rewrites it, atomically, as each stage
starts and ends: `launch`, `open`, `auth`, `mode`, `observe`, `power`, `insert` (the prompt into the composer: one
paste, so a 60 KB prompt takes about a second), `attach` (only for a two-part prompt, below), `send`, `wait`, `read`,
`close`, in the order they run, with elapsed times, `promptSendAttempted` (true from
the moment the send is tried, so a retry never assumes the prompt was not sent),
`promptSubmitted` (true only once the page shows a user turn for it), the launch
timeout, the page counts (initial, before the first navigation, and confirmed
closed inherited and late, and late ones that would not close), the viewport, Chrome's version, the UI map's revision and hash,
the failed stage and the last completed one, and for a two-part prompt `attach`: which outcome (`text` or
`attachment`) and the chip count, and `filled`: how each output was filled (`block`: the rendered
code block labelled with its name, verbatim, two of one name being ambiguous and a failure; `rendered`: the
answer's rendered text, when the site showed the fences as text, WW5d; WW5b; older records have `text`, the Markdown of the removed driver's Copy) and `outsideChars`, the characters outside the output blocks (WW5c). `stripped`: per output, each leaked control token removed from its edges (the UI map's `answer.leakedTokens`, WW6b), when any was. `waitEnded`: how the wait for the answer ended (`done`, `site error`, `timeout`), and `siteError`: true when the newest answer held the site's own error, "This response couldn’t load" (WW6a). That attempt fails at once with the reason "site error: the answer did not load (retryable)", the screenshot and the structure-only snapshot kept; it is never resent. It is partial output `evidence` of
every attempt, succeeded or not (WW6c: the observation records it, so `system work show` lists it and replay keeps it; no Workflow step declares it), and the last line of the log of every attempt.
**A prompt in two parts (WW1g).** `webPrompt` returns the header (role line, step,
instructions, the output-format request, and a line naming the attached inputs), which
the `insert` stage puts in the composer and reads back exactly, and the body (the inputs
and context, fenced and named), which the `attach` stage pastes after it as its own
paste. The site decides what a long paste is: a Team workspace turned 61,581 characters
into an attachment chip (the composer read 2 characters), another account kept 69,410 as
text. The Procedures accept either (the composer holds header and body, or header and
exactly one new chip named by the body's start, with nothing still being added) and
anything else fails before the send in the stage `attach`, with the screenshot and
structure-only DOM above. Inputs under the map's `attachMinChars` stay in the one
part. `timeouts.attach` (seconds) overrides the map's `attachWaitMs` for the wait.
A chip left in the composer by a failed attempt is not removed (the browser closes with the attempt).
The `mode` stage waits for the Chat/Work switch (bounded by `timeouts.mode`, else the
map's `settings.modeReadyMs`) and fails closed as `signed out`, `challenge` or
`mode unknown`.
Cancel and `attemptTimeoutMinutes` close the browser (`context.close()`, a clean
exit), as they stop a CLI; the record names that `close` stage, which is `ok` only
once the browser process (the one in Chrome's `SingletonLock`) has exited. One
that outlives `close()` for 3 s is killed and the stage fails, saying so. A UI
change is a change to the map (`packages/web-driver/ui/chatgpt-web.ui.yaml`),
not to this Runtime. After a lost attempt the Account's slot is held while the
process in Chrome's `SingletonLock` lives.

**One page logic (WW2-iv).** The generic Procedures are the only path; System 1's ChatGPT
driver turn and the account option `procedures` that chose between the two are gone (no
attempt failed at a UI stage in 82+ canary runs on `procedures: generic`, operator decision of
2026-11-08). An account that still sets `procedures`, either value, is `unavailable` with the
reason "procedures was removed: the generic Procedures are the only path; delete the line".
The evidence is still `chatgpt-web-evidence@1` (nothing validates it against a schema, and
`tools/web-canary` reads older records as they are) but no longer holds `procedures`. What the
Procedures do:
- A `send` the page never shows is `unknown`: the attempt fails as "send outcome unknown:
  not resent" and nothing is sent again. A site error keeps "site error: the answer did not
  load (retryable)".
- No model is selected (the `conversation@1` has none). The `observe` stage, after `mode`
  and before `insert`, only reads the model and Power the page shows, and the evidence records
  them as `model` and `powerBefore` (WW8a; a string, or null when unreadable or the map binds no such
  control; never a failure). It opens the model menu, reads, and closes it with Escape, verified
  closed (a menu already open is read as it is and closed too); it never clicks a model or moves
  the slider.
- The Power level comes from the step's tier (WW8b). The `power` stage, after `observe` and
  before `insert`, opens the menu, moves the slider with the arrow keys until the status shows
  the target, reads it back, and closes the menu, verified closed. The levels are read from the
  live menu, never named: `tier.economy` is the first, `tier.standard` the middle one
  (`ceil(total / 2)`), `tier.frontier` the last; a step that asks no tier gets the middle one.
  A level that cannot be reached or read back (a slider that does not move, a menu that
  does not close, a page that has lost the control) fails the attempt in the `power` stage
  before anything is typed, so `promptSendAttempted` is false. The evidence records
  `powerTarget` (`economy`, `standard` or `frontier`), `powerLevels` (the total) and `power`
  (the level the status shows after the selection). A map that binds no Power control has no
  such stage. An Account offers `tier.economy`, `tier.standard` and `tier.frontier` when the
  map binds the control (the `model.open`, `model.close`, `model.power` and `model.power-status`
  entries), and a step that asks a tier (`workflows/research.yaml` asks `tier.standard`) routes
  to it. `tools/web-canary --report` counts the distinct values per Account.
`chatgpt.test.ts` runs the attempt tests once, on the Procedures.

**Login** (`system workers login chatgpt-web/<name> [--cookies <file> | --remote]`,
operator-only operations `workers.login`, `workers.loginRemote` and
`workers.loginWait`): `--cookies` imports a JSON (browser-extension export) or
Netscape cookie file, keeping only chatgpt.com and openai.com cookies and giving
a session cookie a 30-day lifetime, and deletes nothing; the file is read once by
the CLI. With neither flag, a visible window opens on the Host's `DISPLAY` and
waits up to ten minutes for a sign-in. Each uses the same headed browser as an
attempt, so a check cleared in one stays valid for attempts that share the
profile. The signed-in state is then checked and reported; no cookie value is
printed.

`--remote` ([remote-login.ts](src/remote-login.ts)) is for a Host with no display
and for a Cloudflare challenge that only a human can pass. It is a port of System 1's
remote login (the file's header names the source and its commit). It opens the
profile headed on a private Xvfb (over the engine's pipe: no CDP port) with a VNC
server on that Xvfb (`x0vncserver` or `x11vnc`, first found on `PATH`; without
one it fails at once, naming both) reachable only through an owner-only unix
socket, and serves noVNC (`@novnc/novnc` 1.7.0, MPL-2.0, served unmodified;
`ws` 8.22.0 bridges its WebSocket to the socket) on `127.0.0.1` on a random port
under a random 32-byte token (404 without it, and for a Host header other than
loopback). The page shows the whole Xvfb screen, scaled to the window
(`scaleViewport`), with real X input, **Save** and **Cancel** (a POST only from
the page's own origin). `x11vnc` is run per connection with `-inetd` behind a
socket the Host listens on, because 0.9.16 has no unix-socket-only mode and
would open TCP port 5900. The CLI prints the `ssh -L <port>:127.0.0.1:<port> <user>@<host>`
line and the URL; the runbook has the steps. Save closes the browser cleanly (so
`cf_clearance` and the session stay in the profile), checks the signed-in state
(the driver's `checkAuth`) and reports it; Cancel, Ctrl-C or the 15-minute TTL end the session without a
check. Everything it started (Xvfb, VNC server, browser, server) is stopped. Nothing
solves or clicks a challenge.

## Account health (WW6d)

Each Account has a circuit breaker ([health.ts](src/health.ts)): a durable state in its directory, `state.json` beside the profile
(owner-only, written atomically, kept across a Host restart): `ready | cooling | needs-sign-in | challenged`, with the reason,
`since`, `cooldownUntil`, the last success and the last notice. An attempt's outcome moves it, by the evidence's failed stage and
reason:

- **Quarantine at once:** a sign-in wall, the login page or "Session ended, invalid_state" is `needs-sign-in`; a Cloudflare or CAPTCHA
  challenge is `challenged`. A success of another attempt does not clear a quarantine.
- **Cooldown:** a site error ("site error: the answer did not load", the site's own error page) or a suspected rate limit is `cooling`
  for the first of `cooldownSeconds` (account setting, default `[120, 300]`: 2 minutes, then 5 after a consecutive one; the last repeats),
  and ends by itself at `cooldownUntil`. A success clears it and the count.
- **Never the Account's:** a failure attributed to the Host changes nothing: a launch failure, anything before the browser opened the
  Site (the `open` stage did not begin), and a failure while the Host's 1-minute load average is above `hostLoad` (default twice the
  CPUs) at the start or end of the attempt. Cancels, the time limit and failures that say nothing about the Account (a bare timeout, a
  missing output block) leave the state alone; a bare timeout is never read as a rate limit.

While not `ready` the Account's Worker offers no capability, so routing skips it as any unavailable Worker, and the Work controller and
the slots are untouched; it stays registered for a Work that names it. `system workers` shows it `unavailable` with the state and the
action, for example "needs sign-in since 05:10: run `system workers login chatgpt-web/second --remote`, then `system workers recheck
chatgpt-web/second`" (the time is the Host's local time). A state change is noticed once: a line in the Host log and `lastNotice` in the
state; the same state seen again, or a longer cooldown in `cooling`, gives none. There is no automatic retry: a prompt is never resent.

**Recheck** (`system workers recheck <ref>`, operator-only `workers.recheck`, [recheck.ts](src/recheck.ts)) opens the profile headed on its
own Xvfb and runs the driver's `checkAuth`, the Chat mode and, with `temporaryChat`, the temporary chat, without typing or sending. The
Account moves to `ready` only when they pass; it is the only way out of `needs-sign-in` and `challenged` (also from a cooldown, early).
What it finds on the page moves the state as an attempt's failure does; a Chrome that cannot start or a held profile changes nothing. A
successful `login --remote` does the recheck itself, and reports "signed in, but ..." when it fails.

## Limits

The `chatgpt-web` Runtime is outside OpenAI's Terms of Use for its web product; the operator accepted that for their own account (PROP-0005). It needs a Chrome new enough for chatgpt.com: the pinned build is installed under `$DSH_HOME/system/browsers` when no recent one exists.
